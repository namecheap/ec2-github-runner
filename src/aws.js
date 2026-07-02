const {
  EC2Client,
  DescribeImagesCommand,
  DescribeTagsCommand,
  GetConsoleOutputCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  AssociateAddressCommand,
  waitUntilInstanceRunning,
} = require('@aws-sdk/client-ec2');
const core = require('@actions/core');
const config = require('./config');
const log = require('./log');
const { withRetry } = require('./retry');
const { sortByCreationDate } = require('./utils');
const checksums = require('./runner-checksums');

// Instance tag the bootstrap script writes to phone home its progress.
// The start action polls it to fail fast on cloud-init errors instead of
// waiting out the full registration timeout. See buildUserData().
const BOOTSTRAP_TAG_KEY = 'ec2-github-runner:bootstrap';

// Console-output capture caps: keep the printed tail useful but bounded so a
// runaway boot log can't flood the Actions run output.
const CONSOLE_TAIL_LINES = 200;
const CONSOLE_TAIL_BYTES = 64 * 1024;

// EC2Client reads region + credentials from the environment (set by
// aws-actions/configure-aws-credentials or by the instance profile on
// self-hosted runners). A single shared client is fine — commands are
// stateless.
function ec2Client() {
  return new EC2Client({});
}

async function waitForInstanceRunning(ec2InstanceId) {
  const start = Date.now();
  log.info('wait_for_instance', { instance_id: ec2InstanceId });
  try {
    await waitUntilInstanceRunning(
      { client: ec2Client(), maxWaitTime: 300 },
      { InstanceIds: [ec2InstanceId] },
    );
    log.info('wait_for_instance', { instance_id: ec2InstanceId, elapsed_ms: Date.now() - start });
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
  } catch (error) {
    log.error('wait_for_instance', { instance_id: ec2InstanceId, error: error.name, message: error.message });
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

async function resolveImage(client) {
  // Resolves both the image ID and the image's metadata (root-device +
  // block-device mappings). Callers that only need the ID use the .id
  // shortcut; the .image field is used by encrypt-ebs to clone the
  // AMI's BlockDeviceMappings and layer SSE-EBS onto them.
  if (config.input.ec2ImageId) {
    const direct = await client.send(new DescribeImagesCommand({ ImageIds: [config.input.ec2ImageId] }));
    if (!direct.Images || direct.Images.length === 0) {
      throw new Error(`Unable to describe AMI ${config.input.ec2ImageId}`);
    }
    return { id: config.input.ec2ImageId, image: direct.Images[0] };
  }

  const amiParams = {
    Filters: [
      ...config.input.ec2ImageFilters,
      { Name: 'state', Values: ['available'] },
    ],
  };
  if (config.input.ec2ImageOwner) {
    amiParams.Owners = [config.input.ec2ImageOwner];
  }

  log.info('describe_images', { owner: config.input.ec2ImageOwner || null, filters: config.input.ec2ImageFilters });
  const result = await client.send(new DescribeImagesCommand(amiParams));
  if (!result.Images || result.Images.length === 0) {
    log.error('describe_images', { match_count: 0 });
    throw new Error('Unable to find AMI using passed filter');
  }
  sortByCreationDate(result);
  const picked = result.Images[0];
  log.info('describe_images', { match_count: result.Images.length, selected_ami: picked.ImageId });
  log.debug('describe_images_all', { images: result.Images.map(i => ({ id: i.ImageId, name: i.Name, created: i.CreationDate })) });
  return { id: picked.ImageId, image: picked };
}

// Build BlockDeviceMappings that encrypt the AMI's root volume without
// changing its size, type, or iops. Returns null when no root mapping
// is present on the image (exotic AMIs) — caller should skip encryption
// and log a warning rather than ship a broken RunInstances call.
function buildEncryptedRootMapping(image) {
  const rootDev = image.RootDeviceName;
  if (!rootDev || !Array.isArray(image.BlockDeviceMappings)) {
    return null;
  }
  const rootMap = image.BlockDeviceMappings.find((b) => b.DeviceName === rootDev);
  if (!rootMap || !rootMap.Ebs) {
    return null;
  }
  // Clone the EBS config and set Encrypted: true. Drop SnapshotId — AWS
  // will use the AMI's snapshot automatically and re-encrypt during
  // launch under the account's default EBS key.
  const ebsClone = { ...rootMap.Ebs };
  delete ebsClone.SnapshotId;
  return [{
    DeviceName: rootDev,
    Ebs: { ...ebsClone, Encrypted: true },
  }];
}

// Build the cloud-init user-data bootstrap script.
//
// Design notes (fix-forward after ec2-github-runner#18/#19/#20):
//
// - Hashes for the runner tarball come from src/runner-checksums.js
//   (hardcoded table, cross-checked against the release body in CI).
//   The earlier `curl -fsSL <tarball>.sha256` approach died because
//   actions/runner doesn't publish per-tarball .sha256 sidecars.
//
// - Dedicated 'runner' user via useradd + sudo -u. The old
//   RUNNER_ALLOW_RUNASROOT=1 escape hatch is gone. Runner has its own
//   home under /home/runner/ and writes config.sh state there.
//
// - --ephemeral --unattended --disableupdate on config.sh: one-job
//   runner, no interactive prompts, no runtime self-update during the
//   session. GitHub auto-deregisters ephemeral runners after their job,
//   making the removeRunner() API call in gh.js belt-and-braces rather
//   than the primary deregister path.
//
// - set -euo pipefail across both the outer and inner (runner-user)
//   shells so ANY failure kills the bootstrap immediately.
//
// - Bootstrap diagnostics (#41): each phase writes an instance tag
//   (`ec2-github-runner:bootstrap` = preparing → installing →
//   creating-user → downloading → configuring → registered) and an ERR
//   trap writes `failed:<step>` on abort, so the start action can fail
//   fast and name the failing step instead of waiting out the full
//   registration timeout. Tagging is best-effort: it needs
//   `ec2:CreateTags` on the instance profile and degrades to
//   timeout-only detection when absent (every write is `|| true`).
function buildUserData({ runnerVersion, owner, repo, label, githubRegistrationToken, shaX64, shaArm64 }) {
  // Shared shell helpers, emitted verbatim into both the outer (root) and
  // inner (runner-user) shells — each shell re-derives instance identity
  // from IMDS so it can keep phoning home independently.
  const phoneHomeHelpers = [
    'gh_runner_imds() {',
    '  local token',
    '  token=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 120" 2>/dev/null || true)',
    '  curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true',
    '}',
    'GH_RUNNER_IID=$(gh_runner_imds instance-id)',
    'GH_RUNNER_REGION=$(gh_runner_imds placement/region)',
    'gh_runner_phone_home() {',
    '  [ -n "$GH_RUNNER_IID" ] && [ -n "$GH_RUNNER_REGION" ] || return 0',
    `  aws ec2 create-tags --region "$GH_RUNNER_REGION" --resources "$GH_RUNNER_IID" --tags "Key=${BOOTSTRAP_TAG_KEY},Value=$1" >/dev/null 2>&1 || true`,
    '}',
  ];

  return [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    '# --- ec2-github-runner: bootstrap diagnostics (phone-home) ----------',
    ...phoneHomeHelpers,
    'GH_RUNNER_STEP=preparing',
    "trap 'gh_runner_phone_home \"failed:${GH_RUNNER_STEP}\"' ERR",
    '',
    '# Root-required setup.',
    'GH_RUNNER_STEP=preparing',
    'gh_runner_phone_home preparing',
    'mount -o remount,size=1G /tmp',
    'GH_RUNNER_STEP=installing',
    'gh_runner_phone_home installing',
    'yum install -y libicu make sudo',
    '',
    '# Create the non-root runner user (idempotent).',
    'GH_RUNNER_STEP=creating-user',
    'gh_runner_phone_home creating-user',
    'if ! id runner >/dev/null 2>&1; then',
    '  useradd -m -s /bin/bash runner',
    'fi',
    '',
    '# The runner-user shell owns the download/configure/register phases and',
    '# reports them itself; drop the outer ERR trap so it does not overwrite',
    '# the inner shell\'s more specific failed:<step> tag.',
    'trap - ERR',
    "sudo -u runner -H bash <<'RUNNER_BOOTSTRAP'",
    'set -euo pipefail',
    ...phoneHomeHelpers,
    'GH_RUNNER_STEP=downloading',
    "trap 'gh_runner_phone_home \"failed:${GH_RUNNER_STEP}\"' ERR",
    'gh_runner_phone_home downloading',
    'cd "$HOME"',
    'mkdir -p actions-runner && cd actions-runner',
    '',
    'case "$(uname -m)" in',
    '  aarch64) RUNNER_ARCH="arm64" ;;',
    '  amd64|x86_64) RUNNER_ARCH="x64" ;;',
    '  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;',
    'esac',
    '',
    `RUNNER_VERSION="${runnerVersion}"`,
    'TARBALL="actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"',
    'BASE="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}"',
    '',
    'curl -fsSLo "$TARBALL" "$BASE/$TARBALL"',
    '',
    '# SHA-256 verification against the hash baked into the action at',
    '# build time (src/runner-checksums.js). The table is kept in sync',
    '# with upstream by the verify-runner-url CI job on every PR.',
    'case "$RUNNER_ARCH" in',
    `  x64) EXPECTED_SHA="${shaX64}" ;;`,
    `  arm64) EXPECTED_SHA="${shaArm64}" ;;`,
    '  *) echo "no checksum for arch $RUNNER_ARCH" >&2; exit 1 ;;',
    'esac',
    'echo "$EXPECTED_SHA  $TARBALL" | sha256sum -c -',
    '',
    'tar xzf "$TARBALL"',
    '',
    'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
    'GH_RUNNER_STEP=configuring',
    'gh_runner_phone_home configuring',
    `./config.sh --url "https://github.com/${owner}/${repo}" --token "${githubRegistrationToken}" --labels "${label}" --ephemeral --unattended --disableupdate`,
    'GH_RUNNER_STEP=registered',
    'gh_runner_phone_home registered',
    './run.sh',
    'RUNNER_BOOTSTRAP',
    '',
  ].join('\n');
}

async function startEc2Instance(label, githubRegistrationToken) {
  const client = ec2Client();

  const runnerVersion = config.input.runnerVersion;
  const owner = config.githubContext.owner;
  const repo = config.githubContext.repo;
  const shaX64 = checksums.lookup('x64', runnerVersion);
  const shaArm64 = checksums.lookup('arm64', runnerVersion);
  if (!shaX64 || !shaArm64) {
    throw new Error(
      `No SHA-256 entry in src/runner-checksums.js for runner-version ${runnerVersion}. ` +
      'Add the x64 + arm64 hashes from the release body at ' +
      `https://github.com/actions/runner/releases/tag/v${runnerVersion}`,
    );
  }

  const userData = buildUserData({ runnerVersion, owner, repo, label, githubRegistrationToken, shaX64, shaArm64 });

  const resolved = await resolveImage(client);
  config.input.ec2ImageId = resolved.id;

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData).toString('base64'),
    SubnetId: config.input.subnetId,
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications,
    // IMDSv2 required by default. Mitigates SSRF-style IAM credential
    // theft from the runner — any metadata request must present a
    // session token. HttpPutResponseHopLimit: 1 prevents the token
    // from reaching containerized workloads one hop deeper.
    MetadataOptions: {
      HttpTokens: config.input.httpTokens,
      HttpPutResponseHopLimit: 1,
      HttpEndpoint: 'enabled',
    },
  };

  if (config.input.encryptEbs === 'true') {
    const mappings = buildEncryptedRootMapping(resolved.image);
    if (mappings) {
      params.BlockDeviceMappings = mappings;
      log.info('encrypt_ebs', { applied: true, root_device: mappings[0].DeviceName });
    } else {
      log.warn('encrypt_ebs', {
        applied: false,
        reason: 'ami has no root EBS block-device mapping — skipping encryption override',
        ami_id: resolved.id,
      });
    }
  }

  let ec2InstanceId;
  const runStart = Date.now();
  log.info('run_instance', {
    ami_id: config.input.ec2ImageId,
    instance_type: config.input.ec2InstanceType,
    subnet_id: config.input.subnetId,
    sg_id: config.input.securityGroupId,
    iam_role: config.input.iamRoleName || null,
    label,
  });
  try {
    const result = await client.send(new RunInstancesCommand(params));
    ec2InstanceId = result.Instances[0].InstanceId;
    log.info('run_instance', { instance_id: ec2InstanceId, elapsed_ms: Date.now() - runStart });
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
  } catch (error) {
    log.error('run_instance', { error: error.name, message: error.message });
    core.error('AWS EC2 instance starting error');
    throw error;
  }

  if (config.input.eipAllocationId) {
    await waitForInstanceRunning(ec2InstanceId);

    try {
      log.info('associate_address', { allocation_id: config.input.eipAllocationId, instance_id: ec2InstanceId });
      await client.send(new AssociateAddressCommand({
        AllocationId: config.input.eipAllocationId,
        InstanceId: ec2InstanceId,
      }));
    } catch (error) {
      log.warn('associate_address', { allocation_id: config.input.eipAllocationId, instance_id: ec2InstanceId, error: error.name, message: error.message });
      core.warning(`Elastic IP association error, trying to proceed w/o EIP: ${error.message}`);
    }
  }

  return ec2InstanceId;
}

async function terminateInstanceById(ec2InstanceId) {
  const client = ec2Client();

  const start = Date.now();
  log.info('terminate_instance', { instance_id: ec2InstanceId });
  try {
    await withRetry('terminate_instance', () =>
      client.send(new TerminateInstancesCommand({
        InstanceIds: [ec2InstanceId],
      })),
    );
    log.info('terminate_instance', { instance_id: ec2InstanceId, elapsed_ms: Date.now() - start });
    core.info(`AWS EC2 instance ${ec2InstanceId} is terminated`);
  } catch (error) {
    log.error('terminate_instance', { instance_id: ec2InstanceId, error: error.name, message: error.message });
    core.error(`AWS EC2 instance ${ec2InstanceId} termination error`);
    throw error;
  }
}

async function terminateEc2Instance() {
  return terminateInstanceById(config.input.ec2InstanceId);
}

// Read the instance's bootstrap phone-home tag. Returns the tag value
// (e.g. 'downloading', 'failed:configuring') or null when the tag is not
// yet set. Missing ec2:DescribeTags permission (or a transient API error)
// degrades to null so the caller falls back to timeout-based detection
// rather than surfacing a spurious error.
async function getBootstrapStatus(ec2InstanceId) {
  const client = ec2Client();
  try {
    const resp = await client.send(new DescribeTagsCommand({
      Filters: [
        { Name: 'resource-id', Values: [ec2InstanceId] },
        { Name: 'key', Values: [BOOTSTRAP_TAG_KEY] },
      ],
    }));
    const tag = (resp.Tags || []).find((t) => t.Key === BOOTSTRAP_TAG_KEY);
    return tag ? tag.Value : null;
  } catch (error) {
    log.debug('bootstrap_status', { instance_id: ec2InstanceId, error: error.name, message: error.message });
    return null;
  }
}

// Replace every occurrence of each secret value with '***'. Uses literal
// (non-regex) replacement so tokens containing regex metacharacters are
// still fully scrubbed.
function redactSecrets(text, secrets) {
  let out = text;
  for (const secret of secrets || []) {
    if (secret) {
      out = out.split(secret).join('***');
    }
  }
  return out;
}

// Fetch the instance's serial-console output, decode it, and return the
// last CONSOLE_TAIL_LINES lines capped at CONSOLE_TAIL_BYTES, with any
// provided secret values redacted. Returns '' when no output is available
// yet or the call fails (best-effort diagnostics must never mask the
// original error).
async function getConsoleOutputTail(ec2InstanceId, opts = {}) {
  const maxLines = opts.maxLines ?? CONSOLE_TAIL_LINES;
  const maxBytes = opts.maxBytes ?? CONSOLE_TAIL_BYTES;
  const client = ec2Client();

  let output;
  try {
    const resp = await client.send(new GetConsoleOutputCommand({ InstanceId: ec2InstanceId, Latest: true }));
    if (!resp || !resp.Output) {
      return '';
    }
    // EC2 returns the console output base64-encoded.
    output = Buffer.from(resp.Output, 'base64').toString('utf8');
  } catch (error) {
    log.debug('console_output', { instance_id: ec2InstanceId, error: error.name, message: error.message });
    return '';
  }

  let lines = output.split('\n');
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines);
  }
  let tail = lines.join('\n');
  if (Buffer.byteLength(tail, 'utf8') > maxBytes) {
    tail = tail.slice(-maxBytes);
  }
  return redactSecrets(tail, opts.redactValues);
}

// Handle a failed start: capture and print the instance's console output
// (collapsible group, secrets redacted), then either terminate the
// instance (default, so failed starts don't leak billing) or preserve it
// for interactive debugging when cleanup-on-start-failure is 'false'.
// Order is capture-then-terminate so the diagnostics survive the cleanup.
async function handleStartFailure(ec2InstanceId, opts = {}) {
  const tail = await getConsoleOutputTail(ec2InstanceId, { redactValues: opts.redactValues });
  core.startGroup(`EC2 instance ${ec2InstanceId} console output (last ${CONSOLE_TAIL_LINES} lines)`);
  core.info(tail || '(no console output was available yet — the instance may have failed before cloud-init produced output)');
  core.endGroup();

  if (config.input.cleanupOnStartFailure === 'true') {
    log.info('cleanup_on_start_failure', { instance_id: ec2InstanceId, action: 'terminate' });
    try {
      await terminateInstanceById(ec2InstanceId);
    } catch (error) {
      log.error('cleanup_on_start_failure', { instance_id: ec2InstanceId, error: error.name, message: error.message });
      core.warning(`Could not terminate failed instance ${ec2InstanceId}: ${error.message}. Terminate it manually to avoid charges.`);
    }
  } else {
    log.info('cleanup_on_start_failure', { instance_id: ec2InstanceId, action: 'preserve' });
    core.warning(
      `Instance ${ec2InstanceId} was left running for debugging (cleanup-on-start-failure: false).\n` +
      `Inspect it with:\n  aws ec2 get-console-output --latest --instance-id ${ec2InstanceId}\n` +
      `Terminate it when done:\n  aws ec2 terminate-instances --instance-ids ${ec2InstanceId}`,
    );
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  terminateInstanceById,
  waitForInstanceRunning,
  getBootstrapStatus,
  getConsoleOutputTail,
  handleStartFailure,
  // Exported for unit testing.
  buildEncryptedRootMapping,
  buildUserData,
  redactSecrets,
  BOOTSTRAP_TAG_KEY,
};
