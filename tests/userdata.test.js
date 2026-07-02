// Tests for buildUserData — the cloud-init bootstrap script generator.
// It's a pure function, but aws.js requires config.js + @actions/core at
// module load, so those are mocked before require() (jest.mock is hoisted).
jest.mock('../src/config', () => ({
  input: { mode: 'start', debug: 'false' },
  githubContext: { owner: 'o', repo: 'r' },
  tagSpecifications: null,
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setFailed: jest.fn(), getInput: jest.fn(),
  startGroup: jest.fn(), endGroup: jest.fn(),
}));

const { buildUserData, BOOTSTRAP_TAG_KEY } = require('../src/aws');

const args = {
  runnerVersion: '2.335.1',
  owner: 'my-org',
  repo: 'my-repo',
  label: 'runner-abc12',
  githubRegistrationToken: 'AAAA-secret-registration-token-BBBB',
  shaX64: 'x64deadbeef',
  shaArm64: 'arm64deadbeef',
};

describe('buildUserData', () => {
  test('returns a bash script string with strict mode', () => {
    const ud = buildUserData(args);
    expect(typeof ud).toBe('string');
    expect(ud.startsWith('#!/bin/bash\nset -euo pipefail')).toBe(true);
  });

  test('emits a phone-home success tag for every bootstrap phase', () => {
    const ud = buildUserData(args);
    for (const phase of ['preparing', 'installing', 'creating-user', 'downloading', 'configuring', 'registered']) {
      expect(ud).toContain(`gh_runner_phone_home ${phase}`);
    }
  });

  test('sets GH_RUNNER_STEP before each phase so the ERR trap can name it', () => {
    const ud = buildUserData(args);
    for (const phase of ['preparing', 'installing', 'creating-user', 'downloading', 'configuring', 'registered']) {
      expect(ud).toContain(`GH_RUNNER_STEP=${phase}`);
    }
  });

  test('installs an ERR trap that phones home failed:<step> in both shells', () => {
    const ud = buildUserData(args);
    const trapLine = "trap 'gh_runner_phone_home \"failed:${GH_RUNNER_STEP}\"' ERR";
    // Once in the outer (root) shell, once in the inner (runner-user) shell.
    const occurrences = ud.split(trapLine).length - 1;
    expect(occurrences).toBe(2);
  });

  test('writes the bootstrap tag via ec2 create-tags, best-effort', () => {
    const ud = buildUserData(args);
    expect(ud).toContain(`--tags "Key=${BOOTSTRAP_TAG_KEY},Value=$1"`);
    // Best-effort: create-tags failure must never abort the bootstrap.
    expect(ud).toContain('create-tags');
    expect(ud).toMatch(/create-tags .*\|\| true/);
  });

  test('derives instance identity from IMDSv2 (token-authenticated)', () => {
    const ud = buildUserData(args);
    expect(ud).toContain('X-aws-ec2-metadata-token-ttl-seconds');
    expect(ud).toContain('GH_RUNNER_IID=$(gh_runner_imds instance-id)');
    expect(ud).toContain('GH_RUNNER_REGION=$(gh_runner_imds placement/region)');
  });

  test('drops the outer ERR trap before handing off to the runner-user shell', () => {
    const ud = buildUserData(args);
    // The inner shell owns download/configure/register failure attribution.
    expect(ud).toContain('trap - ERR');
    expect(ud.indexOf('trap - ERR')).toBeLessThan(ud.indexOf("sudo -u runner -H bash <<'RUNNER_BOOTSTRAP'"));
  });

  test('embeds runner version, checksums, repo, label, and token into the script', () => {
    const ud = buildUserData(args);
    expect(ud).toContain('RUNNER_VERSION="2.335.1"');
    expect(ud).toContain('EXPECTED_SHA="x64deadbeef"');
    expect(ud).toContain('EXPECTED_SHA="arm64deadbeef"');
    expect(ud).toContain('--url "https://github.com/my-org/my-repo"');
    expect(ud).toContain('--labels "runner-abc12"');
    expect(ud).toContain(`--token "${args.githubRegistrationToken}"`);
  });

  test('configures the runner ephemeral, unattended, and without self-update', () => {
    const ud = buildUserData(args);
    expect(ud).toContain('--ephemeral --unattended --disableupdate');
  });

  test('arms a TTL self-destruct shutdown when max-lifetime-minutes > 0', () => {
    const ud = buildUserData({ ...args, maxLifetimeMinutes: '360' });
    expect(ud).toContain('shutdown -h +360 || true');
  });

  test('omits the TTL shutdown when max-lifetime-minutes is 0', () => {
    const ud = buildUserData({ ...args, maxLifetimeMinutes: '0' });
    expect(ud).not.toContain('shutdown -h');
  });

  test('omits the TTL shutdown when max-lifetime-minutes is unset', () => {
    const ud = buildUserData(args);
    expect(ud).not.toContain('shutdown -h');
  });

  test('injects a pre-runner-script with its own phase tag, before the runner-user handoff', () => {
    const ud = buildUserData({ ...args, preRunnerScript: 'yum install -y docker\nsystemctl start docker' });
    expect(ud).toContain('GH_RUNNER_STEP=pre-runner-script');
    expect(ud).toContain('gh_runner_phone_home pre-runner-script');
    expect(ud).toContain('yum install -y docker');
    expect(ud).toContain('systemctl start docker');
    // Runs as root before dropping to the runner user.
    expect(ud.indexOf('GH_RUNNER_STEP=pre-runner-script')).toBeLessThan(ud.indexOf("sudo -u runner -H bash <<'RUNNER_BOOTSTRAP'"));
  });

  test('omits the pre-runner-script phase entirely when not provided (default byte-identical)', () => {
    const ud = buildUserData(args);
    expect(ud).not.toContain('pre-runner-script');
    // whitespace-only script is treated as absent
    expect(buildUserData({ ...args, preRunnerScript: '   \n  ' })).not.toContain('pre-runner-script');
  });
});
