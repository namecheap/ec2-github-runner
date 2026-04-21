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
const { sortByCreationDate } = require('./utils');

// EC2Client reads region + credentials from the environment (set by
// aws-actions/configure-aws-credentials or by the instance profile on
// self-hosted runners). A single shared client is fine — commands are
// stateless.
function ec2Client() {
  return new EC2Client({});
}

async function waitForInstanceRunning(ec2InstanceId) {
  try {
    await waitUntilInstanceRunning(
      { client: ec2Client(), maxWaitTime: 300 },
      { InstanceIds: [ec2InstanceId] },
    );
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

async function resolveImageId(client) {
  if (config.input.ec2ImageId) {
    return config.input.ec2ImageId;
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

  const result = await client.send(new DescribeImagesCommand(amiParams));
  if (!result.Images || result.Images.length === 0) {
    throw new Error('Unable to find AMI using passed filter');
  }
  sortByCreationDate(result);
  return result.Images[0].ImageId;
}

async function startEc2Instance(label, githubRegistrationToken) {
  const client = ec2Client();

  // User-data runs as root. We install dependencies + create a dedicated
  // 'runner' user, then drop to that user for every subsequent step via
  // a sudo-heredoc. The runner never needs root and never gets it; the
  // old RUNNER_ALLOW_RUNASROOT=1 escape hatch is gone.
  //
  // Runner version is read from config so consumers can override without
  // waiting for an action release (see #10 for the motivation chain).
  //
  // The tarball is SHA-256 verified against actions/runner's published
  // checksum before extraction — same defense-in-depth pattern the
  // provider repo uses for its Go / Terraform downloads.
  //
  // --ephemeral tells GitHub to auto-deregister the runner after it
  // completes a single job; the stop-runner step's explicit removeRunner()
  // call becomes belt-and-braces rather than the primary deregister path.
  const runnerVersion = config.input.runnerVersion;
  const owner = config.githubContext.owner;
  const repo = config.githubContext.repo;
  const userDataScript = [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    '# Root-required setup.',
    'mount -o remount,size=1G /tmp',
    'yum install -y libicu make sudo',
    '',
    '# Create the non-root runner user.',
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
    'expected="$(curl -fsSL "$BASE/$TARBALL.sha256" | awk \'{print $1}\')"',
    'echo "$expected  $TARBALL" | sha256sum -c -',
    '',
    'tar xzf "$TARBALL"',
    '',
    'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
    `./config.sh --url "https://github.com/${owner}/${repo}" --token "${githubRegistrationToken}" --labels "${label}" --ephemeral --unattended --disableupdate`,
    './run.sh',
    'RUNNER_BOOTSTRAP',
    '',
  ];
  const userData = userDataScript;

  config.input.ec2ImageId = await resolveImageId(client);

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
  };

  let ec2InstanceId;
  try {
    const result = await client.send(new RunInstancesCommand(params));
    ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }

  if (config.input.eipAllocationId) {
    await waitForInstanceRunning(ec2InstanceId);

    try {
      await client.send(new AssociateAddressCommand({
        AllocationId: config.input.eipAllocationId,
        InstanceId: ec2InstanceId,
      }));
    } catch (error) {
      core.warning(`Elastic IP association error, trying to proceed w/o EIP: ${error.message}`);
    }
  }

  return ec2InstanceId;
}

async function terminateEc2Instance() {
  const client = ec2Client();

  try {
    await client.send(new TerminateInstancesCommand({
      InstanceIds: [config.input.ec2InstanceId],
    }));
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
