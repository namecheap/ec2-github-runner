const {
  EC2Client,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeTagsCommand,
  GetConsoleOutputCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  CreateTagsCommand,
  ModifyInstanceAttributeCommand,
  AssociateAddressCommand,
  waitUntilInstanceRunning,
} = require('@aws-sdk/client-ec2');
const fs = require('fs');
const core = require('@actions/core');
const config = require('./config');
const log = require('./log');
const { withRetry } = require('./retry');
const { sortByCreationDate, parseCsv } = require('./utils');
const { renderUserDataTemplate, assertUserDataSize } = require('./template');
const checksums = require('./runner-checksums');

// RunInstances error classification for the capacity-fallback chain.
// - capacity: this placement (type × subnet/AZ) has no capacity right now —
//   advance to the next cell in the chain.
// - transient: a retryable API-layer hiccup — retry the same cell.
// - fatal (default): misconfiguration or quota — abort immediately so a
//   bad config doesn't burn through the whole matrix.
const CAPACITY_ERROR_CODES = new Set([
  'InsufficientInstanceCapacity',
  'InsufficientHostCapacity',
  'InsufficientReservedInstanceCapacity',
  'Unsupported',
  'SpotMaxPriceTooLow', // spot capacity (composes with #39)
  'MaxSpotInstanceCountExceeded',
]);
const TRANSIENT_ERROR_CODES = new Set([
  'RequestLimitExceeded',
  'Throttling',
  'ThrottlingException',
  'InternalError',
  'InternalFailure',
  'ServiceUnavailable',
  'Unavailable',
]);

// Map the action's `architecture` input to the AMI Architecture value that
// DescribeImages reports.
const AMI_ARCH_BY_INPUT = { x64: 'x86_64', arm64: 'arm64' };

// Compare an AMI's reported Architecture against the requested architecture.
// Returns true (match), false (mismatch — fail fast), or null (unknown —
// the AMI didn't report an architecture; caller warns and continues).
function matchAmiArchitecture(imageArchitecture, architecture) {
  if (!imageArchitecture) {
    return null;
  }
  return imageArchitecture === AMI_ARCH_BY_INPUT[architecture];
}

function classifyRunError(error) {
  const name = error && error.name;
  if (CAPACITY_ERROR_CODES.has(name)) {
    return 'capacity';
  }
  if (TRANSIENT_ERROR_CODES.has(name)) {
    return 'transient';
  }
  return 'fatal';
}

// Walk the instance-type × subnet fallback chain until one placement
// succeeds. Order: for each instance type, try every subnet/AZ before
// downgrading the type (placement is cheaper than a hardware change). On a
// capacity error, advance to the next cell; on a quota or any other fatal
// error, abort immediately (a misconfig must not burn the whole matrix).
// `attempt(instanceType, subnetId)` is injected (returns the instance id or
// throws), keeping the ordering logic testable without the AWS SDK.
async function launchWithFallback(attempt, instanceTypes, subnetIds) {
  const failures = [];
  for (const instanceType of instanceTypes) {
    for (const subnetId of subnetIds) {
      try {
        const instanceIds = await attempt(instanceType, subnetId);
        return { instanceIds, instanceType, subnetId };
      } catch (error) {
        const kind = classifyRunError(error);
        if (kind === 'capacity') {
          failures.push({ instanceType, subnetId, code: error.name || 'Unknown' });
          log.warn('run_instance_fallback', { instance_type: instanceType, subnet_id: subnetId, error_code: error.name, message: error.message });
          continue;
        }
        if (error.name === 'InstanceLimitExceeded') {
          throw new Error(
            `RunInstances hit an account quota (InstanceLimitExceeded) launching ${instanceType} in ${subnetId}: ${error.message}. ` +
            'This is a service limit, not a capacity shortage — request a quota increase. The fallback chain was not continued.',
            { cause: error },
          );
        }
        throw error;
      }
    }
  }
  const summary = failures.map((f) => `${f.instanceType}/${f.subnetId}=${f.code}`).join('; ');
  const error = new Error(`All ${failures.length} placement attempt(s) failed due to insufficient capacity: ${summary}`);
  error.capacityExhausted = true;
  throw error;
}

// Build the RunInstances InstanceMarketOptions for a spot launch, or
// undefined for on-demand (so on-demand params are byte-identical to
// before spot support). One-time requests fit the launch-use-terminate
// lifecycle — no persistent spot request is left to leak — and the
// interruption behavior is terminate to match the ephemeral runner model.
function buildMarketOptions(marketType, spotMaxPrice) {
  if (marketType !== 'spot') {
    return undefined;
  }
  const spotOptions = {
    SpotInstanceType: 'one-time',
    InstanceInterruptionBehavior: 'terminate',
  };
  if (spotMaxPrice) {
    spotOptions.MaxPrice = String(spotMaxPrice);
  }
  return { MarketType: 'spot', SpotOptions: spotOptions };
}

// The ordered list of market types to try. on-demand launches use just
// ['on-demand']; spot launches try spot first and (unless spot-fallback is
// 'fail') fall back to on-demand once spot capacity is exhausted.
function buildMarketPlan(marketType, spotFallback) {
  if (marketType !== 'spot') {
    return ['on-demand'];
  }
  return spotFallback === 'fail' ? ['spot'] : ['spot', 'on-demand'];
}

// Run the capacity-fallback chain once per market in the plan. Spot is
// tried across the whole type × subnet matrix first; only when that matrix
// is exhausted by capacity/price errors do we downgrade to the next market
// (on-demand). A fatal error inside a market aborts immediately without
// downgrading. attemptFor(marketType) returns the per-cell attempt fn.
async function launchAcrossMarkets(attemptFor, marketPlan, instanceTypes, subnetIds, hooks = {}) {
  for (let i = 0; i < marketPlan.length; i++) {
    const marketType = marketPlan[i];
    try {
      const placement = await launchWithFallback(attemptFor(marketType), instanceTypes, subnetIds);
      return { ...placement, marketType };
    } catch (error) {
      const hasNextMarket = i < marketPlan.length - 1;
      if (error.capacityExhausted && hasNextMarket) {
        if (hooks.onDowngrade) {
          hooks.onDowngrade(marketType, marketPlan[i + 1], error);
        }
        continue;
      }
      throw error;
    }
  }
  /* istanbul ignore next — marketPlan is always non-empty */
  throw new Error('no market attempt was made');
}

// Instance tag the bootstrap script writes to phone home its progress.
// The start action polls it to fail fast on cloud-init errors instead of
// waiting out the full registration timeout. See buildUserData().
const BOOTSTRAP_TAG_KEY = 'ec2-github-runner:bootstrap';

// Signature tags stamped on every instance the action launches. The
// cleanup reaper (mode: cleanup) uses managed + repository to find only
// instances this action started in the current repo, and started-at /
// label to make safe reap decisions. See buildTagSpecifications() and
// listManagedInstances().
const MANAGED_TAG_KEY = 'ec2-github-runner:managed';
const REPO_TAG_KEY = 'ec2-github-runner:repository';
const LABEL_TAG_KEY = 'ec2-github-runner:label';
const STARTED_AT_TAG_KEY = 'ec2-github-runner:started-at';

// Warm-pool tags (reuse: stop). `pool` marks a stop/start-reusable instance
// and its interchangeability group; `cycles` counts how many jobs it has
// served so it can be recycled at reuse-max-cycles.
const POOL_TAG_KEY = 'ec2-github-runner:pool';
const CYCLES_TAG_KEY = 'ec2-github-runner:cycles';

// Shared bootstrap shell helpers, emitted into any shell that phones home:
// derive instance identity from IMDSv2 and tag the bootstrap phase (best-
// effort — needs ec2:CreateTags, degrades silently otherwise).
//
// Failure detail capture: every shell that sources these helpers also
// wires its own stderr through `tee` into a scratch file (GH_RUNNER_ERRLOG),
// so gh_runner_phone_home_failed() can attach a short tail of whatever the
// failing command actually printed to the "failed:<step>" tag — instead of
// just the step name. Value shape: `failed:<step>` (unchanged, no detail
// captured) or `failed:<step>:<detail>`. Step names never contain ':', so
// src/wait.js splits on the FIRST ':' after the failed: prefix to recover
// step vs. detail — safe even if <detail> itself contains colons (e.g. a
// config.sh "error: ..." line). <detail> is sanitized to a single printable
// line and the whole value is hard-capped at 256 chars, the EC2 tag-value
// limit, regardless of how much garbage the failing command emitted.
// gh_runner_phone_home() truncates the scratch file on every *successful*
// (non-"failed:...") call — i.e. right as each new phase begins, before its
// risky commands run — so a step's detail only ever reflects stderr from
// that step's own commands, not noise left behind by an earlier `|| true`
// -tolerated one (e.g. `mount ... || true` still writes to stderr even
// though its exit code is swallowed).
//
// `tee`'s copy into the scratch file happens in a background process
// substitution, so it can lag behind the failing command by a scheduling
// tick — reading the file immediately in the ERR trap can race and see it
// still empty. gh_runner_phone_home_failed() closes this shell's end of
// that pipe (fd 2, about to go away anyway — the script is terminating)
// and polls (bounded: at most ~200ms) for the tee process to exit, which it
// only does once it has drained and flushed everything written to the
// pipe. This is deliberately not a plain `wait` on the tee PID: `wait`
// tracking a process-substitution PID needs bash >= 4.4, and an unbounded
// wait risks hanging the trap if tee's write end ever blocks; `kill -0` for
// liveness works on any bash and the loop always terminates.
const PHONE_HOME_HELPERS = [
  'gh_runner_imds() {',
  '  local token',
  '  token=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 120" 2>/dev/null || true)',
  '  curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true',
  '}',
  'GH_RUNNER_IID=$(gh_runner_imds instance-id)',
  'GH_RUNNER_REGION=$(gh_runner_imds placement/region)',
  '# Tee this shell\'s stderr into a scratch file (best-effort) so a failing',
  '# command\'s own error text can be recovered by gh_runner_phone_home_failed.',
  '# Guarded end-to-end: an empty GH_RUNNER_ERRLOG (mktemp unavailable) just',
  '# skips detail capture, same as any other best-effort tagging failure here.',
  'GH_RUNNER_ERRLOG=$(mktemp /tmp/gh-runner-err.XXXXXX 2>/dev/null || true)',
  'GH_RUNNER_ERRTEE_PID=""',
  'if [ -n "$GH_RUNNER_ERRLOG" ]; then exec 2> >(tee -a "$GH_RUNNER_ERRLOG" >&2) || true; GH_RUNNER_ERRTEE_PID=$!; fi',
  'gh_runner_phone_home() {',
  '  case "$1" in',
  '    failed:*) : ;;',
  '    *) [ -n "${GH_RUNNER_ERRLOG:-}" ] && : > "$GH_RUNNER_ERRLOG" 2>/dev/null || true ;;',
  '  esac',
  '  [ -n "$GH_RUNNER_IID" ] && [ -n "$GH_RUNNER_REGION" ] || return 0',
  `  aws ec2 create-tags --region "$GH_RUNNER_REGION" --resources "$GH_RUNNER_IID" --tags "Key=${BOOTSTRAP_TAG_KEY},Value=$1" >/dev/null 2>&1 || true`,
  '}',
  'gh_runner_phone_home_failed() {',
  '  local step="$1" detail="" value waited=0',
  '  if [ -n "${GH_RUNNER_ERRTEE_PID:-}" ]; then',
  '    exec 2>/dev/null',
  '    while [ "$waited" -lt 10 ] && kill -0 "$GH_RUNNER_ERRTEE_PID" 2>/dev/null; do',
  '      sleep 0.02',
  '      waited=$((waited + 1))',
  '    done',
  '  fi',
  '  if [ -n "${GH_RUNNER_ERRLOG:-}" ] && [ -s "$GH_RUNNER_ERRLOG" ]; then',
  '    detail=$(tr "\\n\\r\\t" "   " < "$GH_RUNNER_ERRLOG" 2>/dev/null | tr -c "[:print:]" " " | tail -c 150 | tr -s " ")',
  '    detail="${detail# }"',
  '    detail="${detail% }"',
  '  fi',
  '  value="failed:${step}"',
  '  [ -n "$detail" ] && value="failed:${step}:${detail}"',
  '  gh_runner_phone_home "${value:0:256}"',
  '}',
];

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

// True when the launch needs a custom root BlockDeviceMapping — i.e. the
// user opted into encryption or any root-volume override. When false the
// caller omits BlockDeviceMappings entirely, so the instance inherits the
// AMI's block device mapping byte-for-byte (zero-diff vs. the default).
function wantsRootDeviceMapping(input) {
  return input.encryptEbs === 'true'
    || !!input.volumeSize
    || !!input.volumeType
    || !!input.volumeIops
    || !!input.volumeThroughput;
}

// Normalize the root-volume-related config inputs (strings) into a typed
// options object for buildRootDeviceMapping. Omitted inputs become
// undefined so the builder leaves the AMI default untouched.
function buildVolumeOpts(input) {
  return {
    encrypt: input.encryptEbs === 'true',
    volumeSize: input.volumeSize ? Number(input.volumeSize) : undefined,
    volumeType: input.volumeType || undefined,
    volumeIops: input.volumeIops ? Number(input.volumeIops) : undefined,
    volumeThroughput: input.volumeThroughput ? Number(input.volumeThroughput) : undefined,
  };
}

// Build BlockDeviceMappings for the AMI's root volume, composing
// encryption (encrypt-ebs) and sizing (volume-size/type/iops/throughput)
// into a single mapping — one writer, not two competing ones. Clones the
// AMI's root Ebs config, drops SnapshotId (AWS uses the AMI's snapshot
// automatically), and applies only the requested overrides so omitted
// inputs keep AMI defaults. DeleteOnTermination is always forced true —
// ephemeral runners must never leak their root volume. Returns null when
// the AMI has no root EBS mapping (exotic AMIs); the caller logs a warning
// rather than shipping a broken RunInstances call. Throws when the
// requested size is smaller than the AMI snapshot (invalid, fail fast).
function buildRootDeviceMapping(image, opts = {}) {
  const rootDev = image.RootDeviceName;
  if (!rootDev || !Array.isArray(image.BlockDeviceMappings)) {
    return null;
  }
  const rootMap = image.BlockDeviceMappings.find((b) => b.DeviceName === rootDev);
  if (!rootMap || !rootMap.Ebs) {
    return null;
  }

  const ebs = { ...rootMap.Ebs };
  const snapshotSize = ebs.VolumeSize;
  delete ebs.SnapshotId;
  ebs.DeleteOnTermination = true;

  if (opts.encrypt) {
    ebs.Encrypted = true;
  }
  if (opts.volumeSize != null) {
    if (snapshotSize != null && opts.volumeSize < snapshotSize) {
      throw new Error(
        `volume-size ${opts.volumeSize} GiB is smaller than the AMI snapshot size ${snapshotSize} GiB; ` +
        'an EBS volume cannot be smaller than the snapshot it is created from.',
      );
    }
    ebs.VolumeSize = opts.volumeSize;
  }
  if (opts.volumeType) {
    ebs.VolumeType = opts.volumeType;
  }
  if (opts.volumeIops != null) {
    ebs.Iops = opts.volumeIops;
  }
  if (opts.volumeThroughput != null) {
    ebs.Throughput = opts.volumeThroughput;
  }

  return [{ DeviceName: rootDev, Ebs: ebs }];
}

// Warm-pool (reuse: stop) bootstrap. The expensive setup — deps, runner
// user, runner tarball download+verify — runs once (idempotent). A per-boot
// systemd service (gh-runner.service) then re-registers and runs a fresh
// ephemeral job on EVERY boot, reading the current registration token /
// label / repo from the instance's IMDS user-data. On a warm start the
// action rewrites that user-data (ModifyInstanceAttribute) with a fresh
// token, so the token never lives in a readable tag and is only exposed via
// IMDS to the instance itself. See warmStartInstance().
function buildReusableUserData({ runnerVersion, owner, repo, label, githubRegistrationToken, shaX64, shaArm64, ttlLines, preRunnerLines }) {
  const repoUrl = `https://github.com/${owner}/${repo}`;

  // The per-boot re-registration script, written to /opt on the instance.
  // Reads the current job params from IMDS user-data (rewritten per warm
  // start), clears any prior registration, then config + run as the runner
  // user. Phone-home tags configuring/registered/failed for diagnostics.
  const registerScript = [
    '#!/bin/bash',
    'set -euo pipefail',
    ...PHONE_HOME_HELPERS,
    'GH_RUNNER_STEP=configuring',
    'trap \'gh_runner_phone_home_failed "${GH_RUNNER_STEP}"\' ERR',
    'IMDS_TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 120" 2>/dev/null || true)',
    'UD=$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/user-data" 2>/dev/null || true)',
    'GH_TOKEN=$(printf \'%s\\n\' "$UD" | sed -n "s/^GH_TOKEN=\'\\(.*\\)\'$/\\1/p" | head -n1)',
    'GH_LABEL=$(printf \'%s\\n\' "$UD" | sed -n "s/^GH_LABEL=\'\\(.*\\)\'$/\\1/p" | head -n1)',
    'GH_REPO_URL=$(printf \'%s\\n\' "$UD" | sed -n "s,^GH_REPO_URL=\'\\(.*\\)\'$,\\1,p" | head -n1)',
    'cd /home/runner/actions-runner',
    'rm -f .runner .credentials .credentials_rsaparams',
    'gh_runner_phone_home configuring',
    'sudo -u runner -H env DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 ./config.sh --url "$GH_REPO_URL" --token "$GH_TOKEN" --labels "$GH_LABEL" --ephemeral --unattended --disableupdate',
    'GH_RUNNER_STEP=registered',
    'gh_runner_phone_home registered',
    'sudo -u runner -H ./run.sh',
  ];

  const serviceUnit = [
    '[Unit]',
    'Description=GitHub Actions ephemeral runner (warm pool)',
    'After=network-online.target',
    'Wants=network-online.target',
    '[Service]',
    'Type=simple',
    'ExecStart=/opt/gh-runner-register.sh',
    '[Install]',
    'WantedBy=multi-user.target',
  ];

  return [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    '# --- ec2-github-runner: warm-pool bootstrap (reuse: stop) -----------',
    ...PHONE_HOME_HELPERS,
    'GH_RUNNER_STEP=preparing',
    "trap 'gh_runner_phone_home_failed \"${GH_RUNNER_STEP}\"' ERR",
    '',
    ...ttlLines,
    '# One-time setup (idempotent across warm restarts).',
    'GH_RUNNER_STEP=preparing',
    'gh_runner_phone_home preparing',
    'mount -o remount,size=1G /tmp || true',
    'GH_RUNNER_STEP=installing',
    'gh_runner_phone_home installing',
    'yum install -y libicu make sudo',
    'GH_RUNNER_STEP=creating-user',
    'gh_runner_phone_home creating-user',
    'if ! id runner >/dev/null 2>&1; then',
    '  useradd -m -s /bin/bash runner',
    'fi',
    '',
    ...preRunnerLines,
    '# Download + verify the runner once (skipped if already present).',
    'GH_RUNNER_STEP=downloading',
    'gh_runner_phone_home downloading',
    'trap - ERR',
    "sudo -u runner -H bash <<'RUNNER_DOWNLOAD'",
    'set -euo pipefail',
    ...PHONE_HOME_HELPERS,
    'GH_RUNNER_STEP=downloading',
    "trap 'gh_runner_phone_home_failed \"${GH_RUNNER_STEP}\"' ERR",
    'gh_runner_phone_home downloading',
    'cd "$HOME"',
    'mkdir -p actions-runner && cd actions-runner',
    'if [ ! -x ./run.sh ]; then',
    '  case "$(uname -m)" in',
    '    aarch64) RUNNER_ARCH="arm64" ;;',
    '    amd64|x86_64) RUNNER_ARCH="x64" ;;',
    '    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;',
    '  esac',
    `  RUNNER_VERSION="${runnerVersion}"`,
    '  TARBALL="actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"',
    '  BASE="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}"',
    '  curl -fsSLo "$TARBALL" "$BASE/$TARBALL"',
    '  case "$RUNNER_ARCH" in',
    `    x64) EXPECTED_SHA="${shaX64}" ;;`,
    `    arm64) EXPECTED_SHA="${shaArm64}" ;;`,
    '    *) echo "no checksum for arch $RUNNER_ARCH" >&2; exit 1 ;;',
    '  esac',
    '  echo "$EXPECTED_SHA  $TARBALL" | sha256sum -c -',
    '  tar xzf "$TARBALL"',
    'fi',
    'RUNNER_DOWNLOAD',
    '',
    '# Current job params. Rewritten per warm start via ModifyInstanceAttribute;',
    '# the per-boot service reads them back from IMDS user-data.',
    `GH_TOKEN='${githubRegistrationToken}'`,
    `GH_LABEL='${label}'`,
    `GH_REPO_URL='${repoUrl}'`,
    '',
    '# Per-boot re-registration script + systemd service.',
    "cat >/opt/gh-runner-register.sh <<'GH_REGISTER_SCRIPT'",
    ...registerScript,
    'GH_REGISTER_SCRIPT',
    'chmod +x /opt/gh-runner-register.sh',
    "cat >/etc/systemd/system/gh-runner.service <<'GH_RUNNER_SERVICE'",
    ...serviceUnit,
    'GH_RUNNER_SERVICE',
    'systemctl daemon-reload',
    'systemctl enable --now gh-runner.service',
    '',
  ].join('\n');
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
//
// - Failure detail capture: the `failed:<step>` tag can carry a
//   trailing `:<detail>` — a sanitized, single-line, ≤150-char tail of
//   whatever the failing command wrote to stderr (see PHONE_HOME_HELPERS
//   and gh_runner_phone_home_failed()) — so a bootstrap failure surfaces
//   the actual error (e.g. config.sh's stderr) without needing live
//   SSH/SSM access. src/wait.js splits on the first ':' after the
//   prefix and stays backward compatible with the no-detail shape.
function buildUserData({ runnerVersion, owner, repo, label, githubRegistrationToken, shaX64, shaArm64, maxLifetimeMinutes, preRunnerScript, reuse }) {
  // User-supplied pre-runner-script (#46): injected verbatim into the outer
  // (root) shell before runner configuration, under the same set -euo
  // pipefail + ERR trap, tagged as its own phase so a failure surfaces as
  // failed:pre-runner-script.
  const preRunnerLines = preRunnerScript && preRunnerScript.trim()
    ? [
      '# User-supplied pre-runner-script (runs as root before runner config).',
      'GH_RUNNER_STEP=pre-runner-script',
      'gh_runner_phone_home pre-runner-script',
      ...preRunnerScript.replace(/\r\n/g, '\n').split('\n'),
      '',
    ]
    : [];

  // TTL self-destruct (#42): arm a shutdown timer as an absolute upper
  // bound on instance lifetime. Combined with
  // InstanceInitiatedShutdownBehavior: terminate on RunInstances (set in
  // startEc2Instance when enabled), the instance terminates itself even if
  // GitHub, the workflow, and the AWS control plane all disappear. '0'
  // disables it (no timer emitted). Best-effort: `|| true` so a missing
  // shutdown binary never aborts the bootstrap.
  const ttl = Number(maxLifetimeMinutes);
  const ttlLines = Number.isFinite(ttl) && ttl > 0
    ? [
      '# TTL self-destruct: hard upper bound on instance lifetime (max-lifetime-minutes).',
      `shutdown -h +${ttl} || true`,
      '',
    ]
    : [];

  // reuse: stop needs a per-boot re-registration hook instead of a one-shot
  // config+run — the runner is set up once but re-registers on every warm
  // start. Kept in a separate builder so the default path stays untouched.
  if (reuse === 'stop') {
    return buildReusableUserData({ runnerVersion, owner, repo, label, githubRegistrationToken, shaX64, shaArm64, ttlLines, preRunnerLines });
  }

  return [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    '# --- ec2-github-runner: bootstrap diagnostics (phone-home) ----------',
    ...PHONE_HOME_HELPERS,
    'GH_RUNNER_STEP=preparing',
    "trap 'gh_runner_phone_home_failed \"${GH_RUNNER_STEP}\"' ERR",
    '',
    ...ttlLines,
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
    ...preRunnerLines,
    '# The runner-user shell owns the download/configure/register phases and',
    '# reports them itself; drop the outer ERR trap so it does not overwrite',
    '# the inner shell\'s more specific failed:<step> tag.',
    'trap - ERR',
    "sudo -u runner -H bash <<'RUNNER_BOOTSTRAP'",
    'set -euo pipefail',
    ...PHONE_HOME_HELPERS,
    'GH_RUNNER_STEP=downloading',
    "trap 'gh_runner_phone_home_failed \"${GH_RUNNER_STEP}\"' ERR",
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

// Build the RunInstances TagSpecifications, stamping every launched
// instance (and its volumes) with the action's signature tags on top of
// any user-supplied aws-resource-tags. The signature lets the cleanup
// reaper positively identify instances this action started in this repo.
// User tags win on key collision (spread last) so callers can't be
// silently overridden — except the reserved signature keys, which are
// re-applied to keep the reaper's guarantees intact.
function buildTagSpecifications(label, startedAtIso) {
  const owner = config.githubContext.owner;
  const repo = config.githubContext.repo;
  const userTags = config.input.awsResourceTags || [];
  const signatureKeys = new Set([MANAGED_TAG_KEY, REPO_TAG_KEY, LABEL_TAG_KEY, STARTED_AT_TAG_KEY, POOL_TAG_KEY, CYCLES_TAG_KEY]);
  const tags = [
    ...userTags.filter((t) => !signatureKeys.has(t.Key)),
    { Key: MANAGED_TAG_KEY, Value: 'true' },
    { Key: REPO_TAG_KEY, Value: `${owner}/${repo}` },
    { Key: LABEL_TAG_KEY, Value: label },
    { Key: STARTED_AT_TAG_KEY, Value: startedAtIso },
  ];
  // Warm-pool membership so a cold-launched instance can be reused later.
  if (config.input.reuse === 'stop') {
    tags.push({ Key: POOL_TAG_KEY, Value: config.input.reusePoolTag });
    tags.push({ Key: CYCLES_TAG_KEY, Value: '0' });
  }
  return [
    { ResourceType: 'instance', Tags: tags },
    { ResourceType: 'volume', Tags: tags },
  ];
}

// Build the warm-pool (reuse: stop) user-data for a fresh token/label —
// used by the warm-start path to rewrite a stopped instance's user-data.
function buildReuseUserData(label, githubRegistrationToken) {
  const runnerVersion = config.input.runnerVersion;
  const shaX64 = checksums.lookup('x64', runnerVersion);
  const shaArm64 = checksums.lookup('arm64', runnerVersion);
  if (!shaX64 || !shaArm64) {
    throw new Error(`No SHA-256 entry in src/runner-checksums.js for runner-version ${runnerVersion}.`);
  }
  return buildUserData({
    runnerVersion,
    owner: config.githubContext.owner,
    repo: config.githubContext.repo,
    label,
    githubRegistrationToken,
    shaX64,
    shaArm64,
    maxLifetimeMinutes: config.input.maxLifetimeMinutes,
    preRunnerScript: config.input.preRunnerScript,
    reuse: 'stop',
  });
}

// Resolve the user-data-template input: a repo-relative path is read from
// disk; anything else is treated as an inline template string.
function resolveUserDataTemplate(templateInput) {
  if (fs.existsSync(templateInput)) {
    return fs.readFileSync(templateInput, 'utf8');
  }
  return templateInput;
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

  const maxLifetimeMinutes = config.input.maxLifetimeMinutes;

  // Bootstrap source (#46): a full user-data-template override renders the
  // documented placeholders; otherwise the built-in yum bootstrap is used,
  // optionally with an injected pre-runner-script. Either way the rendered
  // payload is size-checked against the EC2 16 KB limit.
  let userData;
  if (config.input.userDataTemplate) {
    const template = resolveUserDataTemplate(config.input.userDataTemplate);
    userData = renderUserDataTemplate(template, {
      RUNNER_VERSION: runnerVersion,
      RUNNER_CHECKSUM_X64: shaX64,
      RUNNER_CHECKSUM_ARM64: shaArm64,
      REGISTRATION_TOKEN: githubRegistrationToken,
      REPO_URL: `https://github.com/${owner}/${repo}`,
      LABEL: label,
      TTL_MINUTES: maxLifetimeMinutes,
    });
  } else {
    userData = buildUserData({
      runnerVersion, owner, repo, label, githubRegistrationToken, shaX64, shaArm64, maxLifetimeMinutes,
      preRunnerScript: config.input.preRunnerScript,
      reuse: config.input.reuse,
    });
  }
  assertUserDataSize(userData);

  const resolved = await resolveImage(client);
  config.input.ec2ImageId = resolved.id;

  // Fail fast on an AMI/architecture mismatch — the classic silent failure
  // (an x64 tarball on an arm64 box, or vice versa) becomes a clear error
  // in seconds instead of a registration timeout.
  const amiArchMatch = matchAmiArchitecture(resolved.image.Architecture, config.input.architecture);
  if (amiArchMatch === false) {
    throw new Error(
      `AMI ${resolved.id} is ${resolved.image.Architecture}, but 'architecture' is '${config.input.architecture}' ` +
      `(expected ${AMI_ARCH_BY_INPUT[config.input.architecture]}). Point at an AMI matching the architecture, or fix the input.`,
    );
  } else if (amiArchMatch === null) {
    log.warn('ami_architecture', { applied: false, reason: 'AMI did not report an architecture — skipping arch validation', ami_id: resolved.id });
  }

  // Batch size: MaxCount instances behind one shared label. Default all-or-
  // nothing (MinCount == MaxCount) for clean matrix capacity semantics;
  // allow-partial opts into MinCount 1 (realized count reported in outputs).
  const count = Number(config.input.count);
  const allowPartial = config.input.allowPartial === 'true';

  // InstanceType and SubnetId are injected per attempt by the fallback
  // chain (see below), so they are intentionally absent from the base.
  const params = {
    ImageId: config.input.ec2ImageId,
    MinCount: allowPartial ? 1 : count,
    MaxCount: count,
    UserData: Buffer.from(userData).toString('base64'),
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: buildTagSpecifications(label, new Date().toISOString()),
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

  // TTL self-destruct: terminate (not stop) when the in-instance shutdown
  // timer fires, so the hard lifetime bound actually frees the instance.
  // Only set when the timer is armed (max-lifetime-minutes != 0) to keep
  // the default launch behavior unchanged.
  if (Number(maxLifetimeMinutes) > 0) {
    params.InstanceInitiatedShutdownBehavior = 'terminate';
  }

  if (wantsRootDeviceMapping(config.input)) {
    const mappings = buildRootDeviceMapping(resolved.image, buildVolumeOpts(config.input));
    if (mappings) {
      params.BlockDeviceMappings = mappings;
      log.info('root_volume', {
        applied: true,
        root_device: mappings[0].DeviceName,
        encrypted: mappings[0].Ebs.Encrypted === true,
        volume_size: mappings[0].Ebs.VolumeSize,
        volume_type: mappings[0].Ebs.VolumeType,
      });
    } else {
      log.warn('root_volume', {
        applied: false,
        reason: 'ami has no root EBS block-device mapping — skipping encryption/sizing override',
        ami_id: resolved.id,
      });
    }
  }

  // Capacity fallback: walk instance-type × subnet/AZ in order, advancing
  // on capacity errors and retrying only transient API errors within each
  // cell. Single-value inputs collapse to a one-cell chain (byte-identical
  // to the pre-fallback behavior).
  const instanceTypes = parseCsv(config.input.ec2InstanceType);
  const subnetIds = parseCsv(config.input.subnetId);
  log.info('run_instance', {
    ami_id: config.input.ec2ImageId,
    instance_types: instanceTypes,
    subnet_ids: subnetIds,
    sg_id: config.input.securityGroupId,
    iam_role: config.input.iamRoleName || null,
    label,
  });

  // For each market, build the per-cell attempt that injects the
  // instance type, subnet, and (for spot) the market options.
  const attemptFor = (marketType) => async (instanceType, subnetId) => {
    const attemptParams = { ...params, InstanceType: instanceType, SubnetId: subnetId };
    const marketOptions = buildMarketOptions(marketType, config.input.spotMaxPrice);
    if (marketOptions) {
      attemptParams.InstanceMarketOptions = marketOptions;
    }
    const result = await withRetry(
      'run_instance',
      () => client.send(new RunInstancesCommand(attemptParams)),
      { shouldRetry: (error) => classifyRunError(error) === 'transient' },
    );
    return result.Instances.map((instance) => instance.InstanceId);
  };

  const marketPlan = buildMarketPlan(config.input.marketType, config.input.spotFallback);
  let placement;
  const runStart = Date.now();
  try {
    placement = await launchAcrossMarkets(attemptFor, marketPlan, instanceTypes, subnetIds, {
      onDowngrade: (from, to, error) => {
        log.warn('spot_fallback', { from, to, reason: error.message });
        core.warning(`Spot capacity unavailable — falling back to ${to}`);
      },
    });
  } catch (error) {
    log.error('run_instance', { error: error.name, message: error.message });
    core.error('AWS EC2 instance starting error');
    throw error;
  }
  const instanceIds = placement.instanceIds;
  if (instanceIds.length < count) {
    log.warn('run_instance', { requested: count, realized: instanceIds.length, allow_partial: allowPartial });
    core.warning(`Requested ${count} instance(s) but only ${instanceIds.length} launched (allow-partial).`);
  }
  log.info('run_instance', { instance_ids: instanceIds, instance_type: placement.instanceType, subnet_id: placement.subnetId, market_type: placement.marketType, elapsed_ms: Date.now() - runStart });
  core.info(`Started ${instanceIds.length} EC2 instance(s) [${instanceIds.join(', ')}] (type ${placement.instanceType}, subnet ${placement.subnetId}, ${placement.marketType})`);

  // Elastic IP association only makes sense for a single instance — a lone
  // EIP can't attach to N runners.
  if (config.input.eipAllocationId) {
    if (instanceIds.length !== 1) {
      log.warn('associate_address', { skipped: true, reason: 'eip-allocation-id is ignored for multi-instance batches', count: instanceIds.length });
      core.warning('eip-allocation-id is ignored when count > 1 (a single EIP cannot attach to multiple instances).');
    } else {
      await waitForInstanceRunning(instanceIds[0]);
      try {
        log.info('associate_address', { allocation_id: config.input.eipAllocationId, instance_id: instanceIds[0] });
        await client.send(new AssociateAddressCommand({
          AllocationId: config.input.eipAllocationId,
          InstanceId: instanceIds[0],
        }));
      } catch (error) {
        log.warn('associate_address', { allocation_id: config.input.eipAllocationId, instance_id: instanceIds[0], error: error.name, message: error.message });
        core.warning(`Elastic IP association error, trying to proceed w/o EIP: ${error.message}`);
      }
    }
  }

  return { instanceIds, instanceType: placement.instanceType, subnetId: placement.subnetId, marketType: placement.marketType };
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
      // An already-gone instance (InvalidInstanceID.NotFound) is terminal —
      // don't burn retries; the caller treats it as already-terminated.
      { shouldRetry: (error) => !(error.name && error.name.includes('NotFound')) },
    );
    log.info('terminate_instance', { instance_id: ec2InstanceId, elapsed_ms: Date.now() - start });
    core.info(`AWS EC2 instance ${ec2InstanceId} is terminated`);
  } catch (error) {
    log.error('terminate_instance', { instance_id: ec2InstanceId, error: error.name, message: error.message });
    core.error(`AWS EC2 instance ${ec2InstanceId} termination error`);
    throw error;
  }
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

// For a batch, return the first instance's `failed:<step>` status (so the
// wait loop can fail fast if ANY instance's bootstrap aborts), or null when
// none have failed. Makes N-way waits fail as fast as single ones.
async function getBatchBootstrapStatus(ec2InstanceIds) {
  for (const id of ec2InstanceIds) {
    const status = await getBootstrapStatus(id);
    if (typeof status === 'string' && status.startsWith('failed:')) {
      log.warn('bootstrap_status', { instance_id: id, status });
      return status;
    }
  }
  return null;
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

// Handle a failed start: for every launched instance, capture and print its
// console output (collapsible group, secrets redacted), then either
// terminate all of them (default, so a failed start — including one bad
// instance in a batch — never leaks billing) or preserve them for
// interactive debugging when cleanup-on-start-failure is 'false'. Capture
// happens before termination so the diagnostics survive the cleanup.
// Accepts a single id or an array (single-instance callers unchanged).
async function handleStartFailure(ec2InstanceIds, opts = {}) {
  const ids = Array.isArray(ec2InstanceIds) ? ec2InstanceIds : [ec2InstanceIds];

  for (const id of ids) {
    const tail = await getConsoleOutputTail(id, { redactValues: opts.redactValues });
    core.startGroup(`EC2 instance ${id} console output (last ${CONSOLE_TAIL_LINES} lines)`);
    core.info(tail || '(no console output was available yet — the instance may have failed before cloud-init produced output)');
    core.endGroup();
  }

  if (config.input.cleanupOnStartFailure === 'true') {
    for (const id of ids) {
      log.info('cleanup_on_start_failure', { instance_id: id, action: 'terminate' });
      try {
        await terminateInstanceById(id);
      } catch (error) {
        log.error('cleanup_on_start_failure', { instance_id: id, error: error.name, message: error.message });
        core.warning(`Could not terminate failed instance ${id}: ${error.message}. Terminate it manually to avoid charges.`);
      }
    }
  } else {
    log.info('cleanup_on_start_failure', { instance_ids: ids, action: 'preserve' });
    core.warning(
      `Instance(s) ${ids.join(', ')} left running for debugging (cleanup-on-start-failure: false).\n` +
      `Inspect with:\n  aws ec2 get-console-output --latest --instance-id <id>\n` +
      `Terminate when done:\n  aws ec2 terminate-instances --instance-ids ${ids.join(' ')}`,
    );
  }
}

// List running/pending instances this action launched in the given repo,
// for the cleanup reaper. Filtering is server-side on the full signature
// (managed=true AND repository=repo) and re-validated client-side (belt-
// and-braces: only instances carrying both signature tags are ever
// returned, so a near-miss tag set can never be reaped). Each result
// carries the parsed started-at (ms; falls back to LaunchTime) and label
// the reaper needs to make its decision.
async function listManagedInstances(repo, states = ['pending', 'running']) {
  const client = ec2Client();
  const resp = await client.send(new DescribeInstancesCommand({
    Filters: [
      { Name: `tag:${MANAGED_TAG_KEY}`, Values: ['true'] },
      { Name: `tag:${REPO_TAG_KEY}`, Values: [repo] },
      { Name: 'instance-state-name', Values: states },
    ],
  }));

  const instances = [];
  for (const reservation of resp.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      const tags = {};
      for (const tag of instance.Tags || []) {
        tags[tag.Key] = tag.Value;
      }
      // Client-side re-validation of the full signature.
      if (tags[MANAGED_TAG_KEY] !== 'true' || tags[REPO_TAG_KEY] !== repo) {
        continue;
      }
      const startedAtRaw = tags[STARTED_AT_TAG_KEY];
      const startedAtMs = startedAtRaw && !Number.isNaN(Date.parse(startedAtRaw))
        ? Date.parse(startedAtRaw)
        : (instance.LaunchTime ? new Date(instance.LaunchTime).getTime() : null);
      instances.push({
        instanceId: instance.InstanceId,
        label: tags[LABEL_TAG_KEY] || null,
        startedAtMs,
        state: instance.State ? instance.State.Name : null,
      });
    }
  }
  return instances;
}

// Find one stopped, reusable pool instance matching the full signature +
// pool tag + instance type + architecture (all required; near-misses are
// never returned — the safety guarantee). Returns { instanceId, subnetId }
// or null when the pool is empty.
async function findStoppedPoolInstance({ repo, poolTag, instanceType, architecture }) {
  const client = ec2Client();
  const amiArch = AMI_ARCH_BY_INPUT[architecture];
  const resp = await client.send(new DescribeInstancesCommand({
    Filters: [
      { Name: `tag:${MANAGED_TAG_KEY}`, Values: ['true'] },
      { Name: `tag:${REPO_TAG_KEY}`, Values: [repo] },
      { Name: `tag:${POOL_TAG_KEY}`, Values: [poolTag] },
      { Name: 'instance-state-name', Values: ['stopped'] },
      { Name: 'instance-type', Values: [instanceType] },
    ],
  }));

  for (const reservation of resp.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      const tags = {};
      for (const tag of instance.Tags || []) {
        tags[tag.Key] = tag.Value;
      }
      // Strict client-side re-validation of the full signature.
      if (tags[MANAGED_TAG_KEY] !== 'true' || tags[REPO_TAG_KEY] !== repo || tags[POOL_TAG_KEY] !== poolTag) {
        continue;
      }
      if (instance.InstanceType !== instanceType || (amiArch && instance.Architecture && instance.Architecture !== amiArch)) {
        continue;
      }
      return { instanceId: instance.InstanceId, subnetId: instance.SubnetId };
    }
  }
  return null;
}

// Warm-start a stopped pool instance: rewrite its user-data with the fresh
// registration token/label (so the per-boot service re-registers), update
// its label + started-at tags, then StartInstances.
async function warmStartInstance(instanceId, { userData, label }) {
  const client = ec2Client();
  await client.send(new ModifyInstanceAttributeCommand({
    InstanceId: instanceId,
    // ModifyInstanceAttribute's UserData is a BLOB (BlobAttributeValue.Value:
    // Uint8Array), NOT the plain string RunInstances takes. The SDK
    // base64-encodes the blob's bytes for the EC2 query wire, so hand it the
    // RAW user-data bytes. Pre-encoding to a base64 STRING here double-encodes
    // it: the wire carries base64(base64(userData)), EC2 decodes that once and
    // IMDS then serves the base64 TEXT instead of the script. The warm-restart
    // register step reads that via IMDS, its `sed` finds no GH_REPO_URL='...'
    // line, and config.sh aborts with "Invalid configuration provided for url"
    // — every reuse: stop warm start failed registration this way. Cold
    // launches were unaffected: RunInstances (startEc2Instance) correctly
    // pre-encodes because its UserData field is a string, not a blob.
    UserData: { Value: Buffer.from(userData) },
  }));
  await client.send(new CreateTagsCommand({
    Resources: [instanceId],
    Tags: [
      { Key: LABEL_TAG_KEY, Value: label },
      { Key: STARTED_AT_TAG_KEY, Value: new Date().toISOString() },
    ],
  }));
  await withRetry('start_instance', () => client.send(new StartInstancesCommand({ InstanceIds: [instanceId] })));
  log.info('warm_start', { instance_id: instanceId, label });
  core.info(`Reused warm-pool EC2 instance ${instanceId}`);
}

// Stop (not terminate) an instance so it can be reused from the pool.
async function stopInstanceById(instanceId) {
  const client = ec2Client();
  await withRetry('stop_instance', () => client.send(new StopInstancesCommand({ InstanceIds: [instanceId] })));
  log.info('stop_instance', { instance_id: instanceId });
  core.info(`AWS EC2 instance ${instanceId} is stopped (warm pool)`);
}

// Read the reuse-cycle counter tag for an instance (0 when absent).
async function getInstanceCycles(instanceId) {
  const client = ec2Client();
  try {
    const resp = await client.send(new DescribeTagsCommand({
      Filters: [
        { Name: 'resource-id', Values: [instanceId] },
        { Name: 'key', Values: [CYCLES_TAG_KEY] },
      ],
    }));
    const tag = (resp.Tags || []).find((t) => t.Key === CYCLES_TAG_KEY);
    const n = tag ? parseInt(tag.Value, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch (error) {
    log.debug('instance_cycles', { instance_id: instanceId, error: error.name, message: error.message });
    return 0;
  }
}

// Set the reuse-cycle counter tag.
async function setInstanceCycles(instanceId, cycles) {
  const client = ec2Client();
  await client.send(new CreateTagsCommand({
    Resources: [instanceId],
    Tags: [{ Key: CYCLES_TAG_KEY, Value: String(cycles) }],
  }));
}

module.exports = {
  startEc2Instance,
  terminateInstanceById,
  waitForInstanceRunning,
  getBootstrapStatus,
  getBatchBootstrapStatus,
  getConsoleOutputTail,
  handleStartFailure,
  listManagedInstances,
  findStoppedPoolInstance,
  warmStartInstance,
  stopInstanceById,
  getInstanceCycles,
  setInstanceCycles,
  buildReuseUserData,
  // Exported for unit testing.
  classifyRunError,
  matchAmiArchitecture,
  launchWithFallback,
  launchAcrossMarkets,
  buildMarketOptions,
  buildMarketPlan,
  buildRootDeviceMapping,
  wantsRootDeviceMapping,
  buildVolumeOpts,
  buildUserData,
  buildTagSpecifications,
  redactSecrets,
  BOOTSTRAP_TAG_KEY,
  MANAGED_TAG_KEY,
  REPO_TAG_KEY,
  LABEL_TAG_KEY,
  STARTED_AT_TAG_KEY,
  POOL_TAG_KEY,
  CYCLES_TAG_KEY,
};
