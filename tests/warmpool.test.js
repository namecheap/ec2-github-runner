// Tests for warm-pool (reuse: stop) support: findStoppedPoolInstance strict
// matching, warmStartInstance ordering, stop/cycle helpers, and the per-boot
// re-registration hook in the generated user-data.
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
    expect(Buffer.from(modify.UserData.Value, 'base64').toString('utf8')).toContain('#!/bin/bash');
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
});
