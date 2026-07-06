// Tests for warm-pool (reuse: stop) support: findStoppedPoolInstance strict
// matching, warmStartInstance ordering, stop/cycle helpers, and the per-boot
// re-registration hook in the generated user-data.
const { execFileSync } = require('child_process');

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send: mockSend })),
  DescribeImagesCommand: jest.fn((p) => ({ __command: 'DescribeImages', ...p })),
  DescribeInstancesCommand: jest.fn((p) => ({ __command: 'DescribeInstances', ...p })),
  DescribeTagsCommand: jest.fn((p) => ({ __command: 'DescribeTags', ...p })),
  GetConsoleOutputCommand: jest.fn((p) => ({ __command: 'GetConsoleOutput', ...p })),
  RunInstancesCommand: jest.fn((p) => ({ __command: 'RunInstances', ...p })),
  TerminateInstancesCommand: jest.fn((p) => ({ __command: 'TerminateInstances', ...p })),
  StartInstancesCommand: jest.fn((p) => ({ __command: 'StartInstances', ...p })),
  StopInstancesCommand: jest.fn((p) => ({ __command: 'StopInstances', ...p })),
  CreateTagsCommand: jest.fn((p) => ({ __command: 'CreateTags', ...p })),
  ModifyInstanceAttributeCommand: jest.fn((p) => ({ __command: 'ModifyInstanceAttribute', ...p })),
  AssociateAddressCommand: jest.fn((p) => ({ __command: 'AssociateAddress', ...p })),
  waitUntilInstanceRunning: jest.fn(),
}));
jest.mock('../src/retry', () => ({ withRetry: (_step, fn) => fn() }));
jest.mock('../src/config', () => ({
  input: { mode: 'start', debug: 'false', reuse: 'stop', reusePoolTag: 'ci', architecture: 'x64', awsResourceTags: [] },
  githubContext: { owner: 'my-org', repo: 'my-repo' },
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setFailed: jest.fn(),
  getInput: jest.fn(), startGroup: jest.fn(), endGroup: jest.fn(), debug: jest.fn(),
}));

const aws = require('../src/aws');
const commandsSent = () => mockSend.mock.calls.map((c) => c[0].__command);

beforeEach(() => mockSend.mockReset());

const poolInstance = (over = {}) => ({
  InstanceId: 'i-good',
  InstanceType: 'c7i.4xlarge',
  Architecture: 'x86_64',
  SubnetId: 'subnet-1',
  Tags: [
    { Key: aws.MANAGED_TAG_KEY, Value: 'true' },
    { Key: aws.REPO_TAG_KEY, Value: 'my-org/my-repo' },
    { Key: aws.POOL_TAG_KEY, Value: 'ci' },
  ],
  ...over,
});

describe('findStoppedPoolInstance', () => {
  const query = { repo: 'my-org/my-repo', poolTag: 'ci', instanceType: 'c7i.4xlarge', architecture: 'x64' };

  test('returns a matching stopped instance (id + subnet)', async () => {
    mockSend.mockResolvedValueOnce({ Reservations: [{ Instances: [poolInstance()] }] });
    await expect(aws.findStoppedPoolInstance(query)).resolves.toEqual({ instanceId: 'i-good', subnetId: 'subnet-1' });
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.__command).toBe('DescribeInstances');
    expect(cmd.Filters).toEqual(expect.arrayContaining([
      { Name: `tag:${aws.POOL_TAG_KEY}`, Values: ['ci'] },
      { Name: 'instance-state-name', Values: ['stopped'] },
      { Name: 'instance-type', Values: ['c7i.4xlarge'] },
    ]));
  });

  test('SAFETY: skips near-miss instances (wrong pool / arch / type / unmanaged)', async () => {
    mockSend.mockResolvedValueOnce({ Reservations: [{ Instances: [
      poolInstance({ InstanceId: 'i-wrong-pool', Tags: [
        { Key: aws.MANAGED_TAG_KEY, Value: 'true' }, { Key: aws.REPO_TAG_KEY, Value: 'my-org/my-repo' }, { Key: aws.POOL_TAG_KEY, Value: 'other' },
      ] }),
      poolInstance({ InstanceId: 'i-wrong-arch', Architecture: 'arm64' }),
      poolInstance({ InstanceId: 'i-wrong-type', InstanceType: 'm5.large' }),
      poolInstance({ InstanceId: 'i-unmanaged', Tags: [{ Key: aws.POOL_TAG_KEY, Value: 'ci' }] }),
    ] }] });
    await expect(aws.findStoppedPoolInstance(query)).resolves.toBeNull();
  });

  test('returns null when the pool is empty', async () => {
    mockSend.mockResolvedValueOnce({ Reservations: [] });
    await expect(aws.findStoppedPoolInstance(query)).resolves.toBeNull();
  });
});

describe('warmStartInstance', () => {
  test('rewrites user-data, updates tags, then starts — in that order', async () => {
    mockSend.mockResolvedValue({});
    await aws.warmStartInstance('i-1', { userData: '#!/bin/bash\ntrue', label: 'runner-new' });
    expect(commandsSent()).toEqual(['ModifyInstanceAttribute', 'CreateTags', 'StartInstances']);
    const modify = mockSend.mock.calls[0][0];
    expect(modify.InstanceId).toBe('i-1');
    // UserData.Value must be the RAW user-data bytes, not a pre-base64'd
    // string: it's a blob the SDK base64-encodes on the wire, so a base64
    // string here double-encodes and IMDS serves base64 text (see
    // warmStartInstance + the #66 serialization regression test). Assert the
    // bytes decode straight back to the script — this fails against the old
    // `.toString('base64')` value (a base64 string, not a Buffer/Uint8Array).
    expect(Buffer.isBuffer(modify.UserData.Value) || modify.UserData.Value instanceof Uint8Array).toBe(true);
    expect(Buffer.from(modify.UserData.Value).toString('utf8')).toBe('#!/bin/bash\ntrue');
    const tags = mockSend.mock.calls[1][0].Tags.map((t) => t.Key);
    expect(tags).toContain(aws.LABEL_TAG_KEY);
  });
});

describe('stopInstanceById', () => {
  test('sends StopInstances', async () => {
    mockSend.mockResolvedValue({});
    await aws.stopInstanceById('i-9');
    expect(commandsSent()).toEqual(['StopInstances']);
    expect(mockSend.mock.calls[0][0].InstanceIds).toEqual(['i-9']);
  });
});

describe('getInstanceCycles / setInstanceCycles', () => {
  test('reads the cycles tag as an integer', async () => {
    mockSend.mockResolvedValueOnce({ Tags: [{ Key: aws.CYCLES_TAG_KEY, Value: '7' }] });
    await expect(aws.getInstanceCycles('i-1')).resolves.toBe(7);
  });

  test('returns 0 when the cycles tag is absent', async () => {
    mockSend.mockResolvedValueOnce({ Tags: [] });
    await expect(aws.getInstanceCycles('i-1')).resolves.toBe(0);
  });

  test('returns 0 when DescribeTags fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('denied'));
    await expect(aws.getInstanceCycles('i-1')).resolves.toBe(0);
  });

  test('writes the cycles tag', async () => {
    mockSend.mockResolvedValue({});
    await aws.setInstanceCycles('i-1', 3);
    expect(commandsSent()).toEqual(['CreateTags']);
    expect(mockSend.mock.calls[0][0].Tags).toEqual([{ Key: aws.CYCLES_TAG_KEY, Value: '3' }]);
  });
});

describe('buildUserData — reuse: stop variant', () => {
  const args = { runnerVersion: '2.335.1', owner: 'o', repo: 'r', label: 'l', githubRegistrationToken: 'TOK', shaX64: 'x', shaArm64: 'a' };

  // Isolates the body of the sudo -u runner RUNNER_DOWNLOAD heredoc from the
  // rest of the generated script, so assertions about what runs inside that
  // runner-user shell can't be satisfied by matches elsewhere in the script
  // (the outer root shell's own preparing trap, or the register script's
  // configuring trap).
  const extractRunnerDownloadHeredoc = (ud) => {
    const startMarker = "sudo -u runner -H bash <<'RUNNER_DOWNLOAD'";
    const start = ud.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);
    const bodyStart = start + startMarker.length;
    const end = ud.indexOf('\nRUNNER_DOWNLOAD', bodyStart);
    expect(end).toBeGreaterThan(bodyStart);
    return ud.slice(bodyStart, end);
  };

  test('re-includes PHONE_HOME_HELPERS inside the RUNNER_DOWNLOAD heredoc (regression, #61)', () => {
    const ud = aws.buildUserData({ ...args, reuse: 'stop' });
    const heredoc = extractRunnerDownloadHeredoc(ud);
    // Functions/traps set in the outer (root) shell do not survive the
    // `sudo -u runner` boundary — the helpers must be redefined inside this
    // heredoc, exactly as the plain-path RUNNER_BOOTSTRAP shell does.
    expect(heredoc).toContain('gh_runner_imds() {');
    expect(heredoc).toContain('gh_runner_phone_home() {');
    expect(heredoc).toContain(`Key=${aws.BOOTSTRAP_TAG_KEY},Value=$1`);
  });

  test('arms an ERR trap for the downloading phase inside the RUNNER_DOWNLOAD heredoc (regression, #61)', () => {
    const ud = aws.buildUserData({ ...args, reuse: 'stop' });
    const heredoc = extractRunnerDownloadHeredoc(ud);
    const trapLine = "trap 'gh_runner_phone_home_failed \"${GH_RUNNER_STEP}\"' ERR";
    // Scoped to this heredoc alone: the outer shell's 'preparing' trap and
    // the register script's 'configuring' trap live elsewhere in the script
    // and must not be able to satisfy this assertion.
    expect(heredoc).toContain(trapLine);
    expect(heredoc).toContain('GH_RUNNER_STEP=downloading');
    // The step must be (re)tagged, and the trap (re)armed, before any of the
    // curl/sha256sum/tar commands that can actually fail inside this shell.
    expect(heredoc.indexOf('GH_RUNNER_STEP=downloading')).toBeLessThan(heredoc.indexOf(trapLine));
    expect(heredoc.indexOf(trapLine)).toBeLessThan(heredoc.indexOf('curl -fsSLo'));
  });

  test('installs a per-boot systemd service + IMDS-read re-registration hook', () => {
    const ud = aws.buildUserData({ ...args, reuse: 'stop' });
    expect(ud).toContain('/opt/gh-runner-register.sh');
    expect(ud).toContain('/etc/systemd/system/gh-runner.service');
    expect(ud).toContain('systemctl enable --now gh-runner.service');
    // Re-registration reads the current job params from IMDS user-data.
    expect(ud).toContain('latest/user-data');
    expect(ud).toContain("GH_TOKEN='TOK'");
    expect(ud).toContain('./config.sh');
    expect(ud).toContain('./run.sh');
  });

  test('default (terminate) variant has no warm-pool machinery (regression)', () => {
    const ud = aws.buildUserData({ ...args, reuse: 'terminate' });
    expect(ud).not.toContain('gh-runner.service');
    expect(ud).not.toContain('/opt/gh-runner-register.sh');
  });

  test('GH_REPO_URL extraction survives the sed-delimiter/$# collision (regression, #63)', () => {
    const ud = aws.buildUserData({ ...args, reuse: 'stop' });

    // Pull the real GH_REPO_URL=$(... sed ...) line straight out of the
    // generated script, so this test exercises the actual shipped code
    // rather than a hand-reimplementation of it.
    const marker = 'GH_REPO_URL=$(printf';
    const start = ud.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const end = ud.indexOf('\n', start);
    expect(end).toBeGreaterThan(start);
    const extractionLine = ud.slice(start, end);

    // Run that exact line under 'set -euo pipefail' with a controlled IMDS
    // user-data value, the same shape the real registerScript reads via
    // `UD=$(curl ... /latest/user-data)`. If the sed delimiter collides with
    // bash's `$#` special parameter (as `#` does), the sed invocation is
    // malformed, the pipeline fails, and the assignment aborts the script
    // under `set -e` before GH_REPO_URL is ever printed.
    const script = [
      '#!/bin/bash',
      'set -euo pipefail',
      "UD=\"GH_REPO_URL='https://github.com/foo/bar'\"",
      extractionLine,
      'printf \'%s\' "$GH_REPO_URL"',
    ].join('\n');

    const result = execFileSync('bash', ['-c', script]).toString();
    expect(result).toBe('https://github.com/foo/bar');
  });
});
