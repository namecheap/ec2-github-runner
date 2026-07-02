// Tests for the signature-tag machinery: buildTagSpecifications (stamped
// onto every launched instance) and listManagedInstances (the reaper's
// filter + client-side re-validation). The EC2 client is mocked so the
// DescribeInstances filters and the near-miss safety guard can be asserted.
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send: mockSend })),
  DescribeImagesCommand: jest.fn((p) => ({ __command: 'DescribeImages', ...p })),
  DescribeInstancesCommand: jest.fn((p) => ({ __command: 'DescribeInstances', ...p })),
  DescribeTagsCommand: jest.fn((p) => ({ __command: 'DescribeTags', ...p })),
  GetConsoleOutputCommand: jest.fn((p) => ({ __command: 'GetConsoleOutput', ...p })),
  RunInstancesCommand: jest.fn((p) => ({ __command: 'RunInstances', ...p })),
  TerminateInstancesCommand: jest.fn((p) => ({ __command: 'TerminateInstances', ...p })),
  AssociateAddressCommand: jest.fn((p) => ({ __command: 'AssociateAddress', ...p })),
  waitUntilInstanceRunning: jest.fn(),
}));
jest.mock('../src/config', () => ({
  input: { mode: 'start', debug: 'false', awsResourceTags: [] },
  githubContext: { owner: 'my-org', repo: 'my-repo' },
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setFailed: jest.fn(),
  getInput: jest.fn(), startGroup: jest.fn(), endGroup: jest.fn(), debug: jest.fn(),
}));

const config = require('../src/config');
const aws = require('../src/aws');

const tagsOf = (spec) => {
  const out = {};
  for (const t of spec.Tags) out[t.Key] = t.Value;
  return out;
};

beforeEach(() => {
  mockSend.mockReset();
  config.input.awsResourceTags = [];
});

describe('buildTagSpecifications', () => {
  test('stamps the full signature on both instance and volume', () => {
    const specs = aws.buildTagSpecifications('runner-abc12', '2026-07-02T18:00:00.000Z');
    expect(specs.map((s) => s.ResourceType)).toEqual(['instance', 'volume']);
    for (const spec of specs) {
      const t = tagsOf(spec);
      expect(t[aws.MANAGED_TAG_KEY]).toBe('true');
      expect(t[aws.REPO_TAG_KEY]).toBe('my-org/my-repo');
      expect(t[aws.LABEL_TAG_KEY]).toBe('runner-abc12');
      expect(t[aws.STARTED_AT_TAG_KEY]).toBe('2026-07-02T18:00:00.000Z');
    }
  });

  test('merges user-supplied tags alongside the signature', () => {
    config.input.awsResourceTags = [{ Key: 'Owner', Value: 'devops' }];
    const t = tagsOf(aws.buildTagSpecifications('l', 'ts')[0]);
    expect(t.Owner).toBe('devops');
    expect(t[aws.MANAGED_TAG_KEY]).toBe('true');
  });

  test('never lets a user tag override a reserved signature key', () => {
    config.input.awsResourceTags = [{ Key: aws.MANAGED_TAG_KEY, Value: 'false' }, { Key: aws.REPO_TAG_KEY, Value: 'evil/repo' }];
    const t = tagsOf(aws.buildTagSpecifications('l', 'ts')[0]);
    expect(t[aws.MANAGED_TAG_KEY]).toBe('true');
    expect(t[aws.REPO_TAG_KEY]).toBe('my-org/my-repo');
    // and only one entry per reserved key
    const managedCount = aws.buildTagSpecifications('l', 'ts')[0].Tags.filter((x) => x.Key === aws.MANAGED_TAG_KEY).length;
    expect(managedCount).toBe(1);
  });
});

describe('listManagedInstances', () => {
  test('filters server-side on managed + repository + running state', async () => {
    mockSend.mockResolvedValueOnce({ Reservations: [] });
    await aws.listManagedInstances('my-org/my-repo');
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.__command).toBe('DescribeInstances');
    expect(cmd.Filters).toEqual([
      { Name: `tag:${aws.MANAGED_TAG_KEY}`, Values: ['true'] },
      { Name: `tag:${aws.REPO_TAG_KEY}`, Values: ['my-org/my-repo'] },
      { Name: 'instance-state-name', Values: ['pending', 'running'] },
    ]);
  });

  test('returns instance id, label, and parsed started-at', async () => {
    mockSend.mockResolvedValueOnce({
      Reservations: [{
        Instances: [{
          InstanceId: 'i-1',
          LaunchTime: '2026-07-02T10:00:00.000Z',
          Tags: [
            { Key: aws.MANAGED_TAG_KEY, Value: 'true' },
            { Key: aws.REPO_TAG_KEY, Value: 'my-org/my-repo' },
            { Key: aws.LABEL_TAG_KEY, Value: 'runner-xyz' },
            { Key: aws.STARTED_AT_TAG_KEY, Value: '2026-07-02T12:00:00.000Z' },
          ],
        }],
      }],
    });
    const result = await aws.listManagedInstances('my-org/my-repo');
    expect(result).toEqual([{ instanceId: 'i-1', label: 'runner-xyz', startedAtMs: Date.parse('2026-07-02T12:00:00.000Z') }]);
  });

  test('falls back to LaunchTime when started-at tag is missing', async () => {
    mockSend.mockResolvedValueOnce({
      Reservations: [{
        Instances: [{
          InstanceId: 'i-2',
          LaunchTime: '2026-07-02T10:00:00.000Z',
          Tags: [
            { Key: aws.MANAGED_TAG_KEY, Value: 'true' },
            { Key: aws.REPO_TAG_KEY, Value: 'my-org/my-repo' },
          ],
        }],
      }],
    });
    const result = await aws.listManagedInstances('my-org/my-repo');
    expect(result[0].startedAtMs).toBe(Date.parse('2026-07-02T10:00:00.000Z'));
    expect(result[0].label).toBeNull();
  });

  test('SAFETY: excludes near-miss instances the server filter might return', async () => {
    // Defense in depth: even if a malformed DescribeInstances response
    // surfaced instances without the full signature, they must not be
    // eligible for reaping.
    mockSend.mockResolvedValueOnce({
      Reservations: [{
        Instances: [
          { InstanceId: 'i-good', Tags: [{ Key: aws.MANAGED_TAG_KEY, Value: 'true' }, { Key: aws.REPO_TAG_KEY, Value: 'my-org/my-repo' }] },
          { InstanceId: 'i-wrong-repo', Tags: [{ Key: aws.MANAGED_TAG_KEY, Value: 'true' }, { Key: aws.REPO_TAG_KEY, Value: 'other/repo' }] },
          { InstanceId: 'i-not-managed', Tags: [{ Key: aws.REPO_TAG_KEY, Value: 'my-org/my-repo' }] },
          { InstanceId: 'i-untagged', Tags: [] },
        ],
      }],
    });
    const result = await aws.listManagedInstances('my-org/my-repo');
    expect(result.map((r) => r.instanceId)).toEqual(['i-good']);
  });
});
