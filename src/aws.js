const {
  EC2Client,
  DescribeImagesCommand,
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

async function startEc2Instance(label, githubRegistrationToken) {
  const client = ec2Client();

  // Bootstrap design notes (fix-forward after ec2-github-runner#18/#19/#20):
  //
  // - Hashes for the runner tarball come from src/runner-checksums.js
  //   (hardcoded table, cross-checked against the release body in CI).
  //   The earlier `curl -fsSL <tarball>.sha256` approach died because
  //   actions/runner doesn't publish per-tarball .sha256 sidecars.
  //
  // - Dedicated 'runner' user via useradd + sudo -u. The old
  //   RUNNER_ALLOW_RUNASROOT=1 escape hatch is gone. Runner has its
  //   own home under /home/runner/ and writes config.sh state there.
  //
  // - --ephemeral --unattended --disableupdate on config.sh: one-job
  //   runner, no interactive prompts, no runtime self-update during
  //   the session. GitHub auto-deregisters ephemeral runners after
  //   their job, making the removeRunner() API call in gh.js become
  //   belt-and-braces rather than the primary deregister path.
  //
  // - set -euo pipefail across both the outer and inner (runner-user)
  //   shells so ANY failure kills the bootstrap immediately. Made
  //   failures diagnosable in the Phase 4.b attempt (see #20 for the
  //   `aws ec2 get-console-output --latest` recipe).
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

  const userData = [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    '# Root-required setup.',
    'mount -o remount,size=1G /tmp',
    'yum install -y libicu make sudo',
    '',
    '# Create the non-root runner user (idempotent).',
    'if ! id runner >/dev/null 2>&1; then',
    '  useradd -m -s /bin/bash runner',
    'fi',
    '',
    '# Drop to the runner user for download + configure + run.',
    "sudo -u runner -H bash <<'RUNNER_BOOTSTRAP'",
    'set -euo pipefail',
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
    `./config.sh --url "https://github.com/${owner}/${repo}" --token "${githubRegistrationToken}" --labels "${label}" --ephemeral --unattended --disableupdate`,
    './run.sh',
    'RUNNER_BOOTSTRAP',
    '',
  ];

  const resolved = await resolveImage(client);
  config.input.ec2ImageId = resolved.id;

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
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

async function terminateEc2Instance() {
  const client = ec2Client();

  const start = Date.now();
  log.info('terminate_instance', { instance_id: config.input.ec2InstanceId });
  try {
    await withRetry('terminate_instance', () =>
      client.send(new TerminateInstancesCommand({
        InstanceIds: [config.input.ec2InstanceId],
      })),
    );
    log.info('terminate_instance', { instance_id: config.input.ec2InstanceId, elapsed_ms: Date.now() - start });
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
  } catch (error) {
    log.error('terminate_instance', { instance_id: config.input.ec2InstanceId, error: error.name, message: error.message });
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
  // Exported for unit testing.
  buildEncryptedRootMapping,
};
