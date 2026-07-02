const core = require('@actions/core');
const github = require('@actions/github');

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
      securityGroupId: core.getInput('security-group-id'),
      eipAllocationId: core.getInput('eip-allocation-id'),
      label: core.getInput('label'),
      ec2InstanceId: core.getInput('ec2-instance-id'),
      iamRoleName: core.getInput('iam-role-name'),
      runnerVersion: core.getInput('runner-version') || '2.335.1',
      httpTokens: core.getInput('http-tokens') || 'required',
      encryptEbs: core.getInput('encrypt-ebs') || 'false',
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
    } else if (this.input.mode === 'stop') {
      if (!this.input.label || !this.input.ec2InstanceId) {
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
