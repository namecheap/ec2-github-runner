const core = require('@actions/core');
const github = require('@actions/github');
const { parseCsv, instanceArch } = require('./utils');

class Config {
  constructor() {
    this.input = {
      mode: core.getInput('mode'),
      githubToken: core.getInput('github-token'),
      ec2ImageFilters: core.getInput('ec2-image-filters') ? JSON.parse(core.getInput('ec2-image-filters')) : null,
      ec2ImageOwner: core.getInput('ec2-image-owner'),
      ec2ImageId: core.getInput('ec2-image-id'),
      ec2InstanceType: core.getInput('ec2-instance-type'),
      subnetId: core.getInput('subnet-id'),
      marketType: core.getInput('market-type') || 'on-demand',
      spotFallback: core.getInput('spot-fallback') || 'on-demand',
      spotMaxPrice: core.getInput('spot-max-price'),
      securityGroupId: core.getInput('security-group-id'),
      eipAllocationId: core.getInput('eip-allocation-id'),
      label: core.getInput('label'),
      ec2InstanceId: core.getInput('ec2-instance-id'),
      ec2InstanceIds: core.getInput('ec2-instance-ids') ? JSON.parse(core.getInput('ec2-instance-ids')) : null,
      count: core.getInput('count') || '1',
      allowPartial: core.getInput('allow-partial') || 'false',
      preRunnerScript: core.getInput('pre-runner-script'),
      userDataTemplate: core.getInput('user-data-template'),
      iamRoleName: core.getInput('iam-role-name'),
      runnerVersion: core.getInput('runner-version') || '2.335.1',
      architecture: core.getInput('architecture') || 'x64',
      httpTokens: core.getInput('http-tokens') || 'required',
      encryptEbs: core.getInput('encrypt-ebs') || 'false',
      volumeSize: core.getInput('volume-size'),
      volumeType: core.getInput('volume-type'),
      volumeIops: core.getInput('volume-iops'),
      volumeThroughput: core.getInput('volume-throughput'),
      cleanupOnStartFailure: core.getInput('cleanup-on-start-failure') || 'true',
      maxLifetimeMinutes: core.getInput('max-lifetime-minutes') || '360',
      maxAgeMinutes: core.getInput('max-age-minutes') || '120',
      dryRun: core.getInput('dry-run') || 'false',
      debug: core.getInput('debug') || 'false',
    };

    // Raw user-supplied resource tags. The action always merges its own
    // signature tags (managed/repository/label/started-at — see
    // src/aws.js) on top of these so the cleanup reaper can identify
    // instances it launched.
    this.input.awsResourceTags = JSON.parse(core.getInput('aws-resource-tags'));

    // the values of github.context.repo.owner and github.context.repo.repo are taken from
    // the environment variable GITHUB_REPOSITORY specified in "owner/repo" format and
    // provided by the GitHub Action on the runtime
    this.githubContext = {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
    };

    //
    // validate input
    //

    if (!this.input.mode) {
      throw new Error(`The 'mode' input is not specified`);
    }

    if (!this.input.githubToken) {
      throw new Error(`The 'github-token' input is not specified`);
    }

    if (this.input.mode === 'start') {
      if (!this.input.ec2InstanceType || !this.input.subnetId || !this.input.securityGroupId) {
        throw new Error(`Not all the required inputs are provided for the 'start' mode`);
      }
      if (!this.input.ec2ImageId && !this.input.ec2ImageFilters) {
        throw new Error(`Not all the required inputs for AMI search are provided for the 'start' mode`);
      }
      this.validateVolumeInputs();
      this.validateMarketInputs();
      this.validateArchitectureInputs();
      this.validateCountInput();
      this.validateBootstrapInputs();
    } else if (this.input.mode === 'stop') {
      // A stop needs the shared label plus at least one instance id — either
      // the compat scalar or the JSON array from a batched start.
      if (!this.input.label || (!this.input.ec2InstanceId && !(this.input.ec2InstanceIds && this.input.ec2InstanceIds.length))) {
        throw new Error(`Not all the required inputs are provided for the 'stop' mode`);
      }
    } else if (this.input.mode === 'cleanup') {
      // The reaper needs only the github-token (validated above) and
      // operates on the current repository; max-age-minutes and dry-run
      // have safe defaults.
    } else {
      throw new Error('Wrong mode. Allowed values: start, stop, cleanup.');
    }
  }

  // Validate the root-volume inputs against EBS rules that don't need the
  // AMI (fail in seconds at config parse). The size-vs-snapshot check needs
  // the DescribeImages data and lives in src/aws.js buildRootDeviceMapping.
  validateVolumeInputs() {
    const { volumeSize, volumeType, volumeIops, volumeThroughput } = this.input;
    const ALLOWED_TYPES = ['gp3', 'gp2', 'io1', 'io2'];
    const IOPS_TYPES = ['gp3', 'io1', 'io2'];
    const isPositiveInt = (v) => /^[0-9]+$/.test(v) && Number(v) > 0;

    if (volumeSize && !isPositiveInt(volumeSize)) {
      throw new Error(`'volume-size' must be a positive integer (GiB)`);
    }
    if (volumeIops && !isPositiveInt(volumeIops)) {
      throw new Error(`'volume-iops' must be a positive integer`);
    }
    if (volumeThroughput && !isPositiveInt(volumeThroughput)) {
      throw new Error(`'volume-throughput' must be a positive integer (MiB/s)`);
    }
    if (volumeType && !ALLOWED_TYPES.includes(volumeType)) {
      throw new Error(`'volume-type' must be one of: ${ALLOWED_TYPES.join(', ')}`);
    }
    if (volumeIops && !IOPS_TYPES.includes(volumeType)) {
      throw new Error(`'volume-iops' is only valid with 'volume-type' one of: ${IOPS_TYPES.join(', ')}`);
    }
    if (volumeThroughput && volumeType !== 'gp3') {
      throw new Error(`'volume-throughput' is only valid with 'volume-type' gp3`);
    }
  }

  // Validate the spot/market inputs at config parse (fail fast before any
  // AWS call). See src/aws.js buildMarketOptions/buildMarketPlan.
  validateMarketInputs() {
    const { marketType, spotFallback, spotMaxPrice } = this.input;
    if (!['on-demand', 'spot'].includes(marketType)) {
      throw new Error(`'market-type' must be one of: on-demand, spot`);
    }
    if (!['on-demand', 'fail'].includes(spotFallback)) {
      throw new Error(`'spot-fallback' must be one of: on-demand, fail`);
    }
    // Positive decimal string, e.g. "0.05" or "1". Empty = AWS default cap.
    if (spotMaxPrice && !(/^[0-9]+(\.[0-9]+)?$/.test(spotMaxPrice) && Number(spotMaxPrice) > 0)) {
      throw new Error(`'spot-max-price' must be a positive decimal (USD/hour), e.g. 0.05`);
    }
  }

  // Validate the architecture input and that the ec2-instance-type fallback
  // list is single-architecture and consistent with it. Placement and arch
  // are kept orthogonal: a fallback chain must not mix arm64 and x64 types.
  validateArchitectureInputs() {
    const arch = this.input.architecture;
    if (!['x64', 'arm64'].includes(arch)) {
      throw new Error(`'architecture' must be one of: x64, arm64`);
    }
    const types = parseCsv(this.input.ec2InstanceType);
    const arches = [...new Set(types.map(instanceArch))];
    if (arches.length > 1) {
      throw new Error(`'ec2-instance-type' mixes architectures (${types.join(', ')}); all types in a fallback list must share one architecture`);
    }
    if (types.length > 0 && !arches.includes(arch)) {
      throw new Error(`'ec2-instance-type' (${types.join(', ')}) looks like ${arches[0]} but 'architecture' is '${arch}'`);
    }
  }

  // The two bootstrap-extension inputs are mutually exclusive: pre-runner-
  // script augments the built-in bootstrap, user-data-template replaces it.
  validateBootstrapInputs() {
    if (this.input.userDataTemplate && this.input.preRunnerScript) {
      throw new Error(`'user-data-template' and 'pre-runner-script' are mutually exclusive`);
    }
  }

  // Validate the multi-runner batch size.
  validateCountInput() {
    if (!(/^[0-9]+$/.test(this.input.count) && Number(this.input.count) >= 1)) {
      throw new Error(`'count' must be a positive integer`);
    }
  }

  generateUniqueLabel() {
    return Math.random().toString(36).substr(2, 5);
  }
}

try {
  module.exports = new Config();
} catch (error) {
  core.error(error);
  core.setFailed(error.message);
}
