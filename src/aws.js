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

  log.info('describe_images', { owner: config.input.ec2ImageOwner || null, filters: config.input.ec2ImageFilters });
  const result = await client.send(new DescribeImagesCommand(amiParams));
  if (!result.Images || result.Images.length === 0) {
    log.error('describe_images', { match_count: 0 });
    throw new Error('Unable to find AMI using passed filter');
  }
  sortByCreationDate(result);
  const picked = result.Images[0].ImageId;
  log.info('describe_images', { match_count: result.Images.length, selected_ami: picked });
  log.debug('describe_images_all', { images: result.Images.map(i => ({ id: i.ImageId, name: i.Name, created: i.CreationDate })) });
  return picked;
}

async function startEc2Instance(label, githubRegistrationToken) {
  const client = ec2Client();

  // User data scripts are run as the root user.
  // Docker and git are necessary for GitHub runner and should be pre-installed on the AMI.
  const userData = [
    '#!/bin/bash',
    'mount -o remount,size=1G /tmp',
    'yum install -y libicu make',
    'mkdir actions-runner && cd actions-runner',
    'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
    'curl -O -L https://github.com/actions/runner/releases/download/v2.333.1/actions-runner-linux-${RUNNER_ARCH}-2.333.1.tar.gz',
    'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.333.1.tar.gz',
    'export RUNNER_ALLOW_RUNASROOT=1',
    'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
    `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
    './run.sh',
  ];

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
};
