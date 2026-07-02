// Tests for the bootstrap-diagnostics helpers in src/aws.js:
// getBootstrapStatus, getConsoleOutputTail, redactSecrets, handleStartFailure.
//
// The EC2 client is mocked so a single mockSend records every command in
// call order — used to assert the capture-then-terminate ordering. withRetry
// is stubbed to call through once so terminate failures don't incur backoff
// delays. jest.mock is hoisted, so the mockSend name is `mock`-prefixed to
// satisfy the out-of-scope-reference guard.
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send: mockSend })),
  DescribeImagesCommand: jest.fn((p) => ({ __command: 'DescribeImages', ...p })),
  DescribeTagsCommand: jest.fn((p) => ({ __command: 'DescribeTags', ...p })),
  GetConsoleOutputCommand: jest.fn((p) => ({ __command: 'GetConsoleOutput', ...p })),
  RunInstancesCommand: jest.fn((p) => ({ __command: 'RunInstances', ...p })),
  TerminateInstancesCommand: jest.fn((p) => ({ __command: 'TerminateInstances', ...p })),
  AssociateAddressCommand: jest.fn((p) => ({ __command: 'AssociateAddress', ...p })),
  waitUntilInstanceRunning: jest.fn(),
}));
jest.mock('../src/retry', () => ({ withRetry: (_step, fn) => fn() }));
jest.mock('../src/config', () => ({
  input: { mode: 'start', debug: 'false', cleanupOnStartFailure: 'true' },
  githubContext: { owner: 'o', repo: 'r' },
  tagSpecifications: null,
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setFailed: jest.fn(),
  getInput: jest.fn(), startGroup: jest.fn(), endGroup: jest.fn(), debug: jest.fn(),
}));

const core = require('@actions/core');
const config = require('../src/config');
const aws = require('../src/aws');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const commandsSent = () => mockSend.mock.calls.map((c) => c[0].__command);

beforeEach(() => {
  mockSend.mockReset();
  core.info.mockClear();
  core.warning.mockClear();
  core.error.mockClear();
  core.startGroup.mockClear();
  core.endGroup.mockClear();
  config.input.cleanupOnStartFailure = 'true';
});

describe('redactSecrets', () => {
  test('replaces every occurrence of each secret with ***', () => {
    expect(aws.redactSecrets('a TOK b TOK c', ['TOK'])).toBe('a *** b *** c');
  });

  test('ignores empty / undefined secrets', () => {
    expect(aws.redactSecrets('hello', ['', undefined])).toBe('hello');
    expect(aws.redactSecrets('hello', [])).toBe('hello');
    expect(aws.redactSecrets('hello', undefined)).toBe('hello');
  });

  test('treats secrets literally, not as regex', () => {
    expect(aws.redactSecrets('x a.b.c y', ['a.b.c'])).toBe('x *** y');
    expect(aws.redactSecrets('keep aXbXc', ['a.b.c'])).toBe('keep aXbXc');
  });
});

describe('getBootstrapStatus', () => {
  test('returns the bootstrap tag value when present', async () => {
    mockSend.mockResolvedValueOnce({ Tags: [{ Key: aws.BOOTSTRAP_TAG_KEY, Value: 'downloading' }] });
    await expect(aws.getBootstrapStatus('i-123')).resolves.toBe('downloading');
    // Scoped to the instance and the bootstrap key.
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.__command).toBe('DescribeTags');
    expect(cmd.Filters).toEqual([
      { Name: 'resource-id', Values: ['i-123'] },
      { Name: 'key', Values: [aws.BOOTSTRAP_TAG_KEY] },
    ]);
  });

  test('surfaces a failed:<step> value verbatim', async () => {
    mockSend.mockResolvedValueOnce({ Tags: [{ Key: aws.BOOTSTRAP_TAG_KEY, Value: 'failed:configuring' }] });
    await expect(aws.getBootstrapStatus('i-123')).resolves.toBe('failed:configuring');
  });

  test('returns null when the tag is not set yet', async () => {
    mockSend.mockResolvedValueOnce({ Tags: [] });
    await expect(aws.getBootstrapStatus('i-123')).resolves.toBeNull();
  });

  test('degrades to null when DescribeTags is denied (missing permission)', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('not authorized'), { name: 'UnauthorizedOperation' }));
    await expect(aws.getBootstrapStatus('i-123')).resolves.toBeNull();
  });
});

describe('getBatchBootstrapStatus', () => {
  const tagsFor = (value) => ({ Tags: value ? [{ Key: aws.BOOTSTRAP_TAG_KEY, Value: value }] : [] });

  test('returns the first failed:<step> across the batch', async () => {
    mockSend.mockImplementation((cmd) => {
      const id = cmd.Filters.find((f) => f.Name === 'resource-id').Values[0];
      return Promise.resolve(id === 'i-2' ? tagsFor('failed:configuring') : tagsFor('downloading'));
    });
    await expect(aws.getBatchBootstrapStatus(['i-1', 'i-2', 'i-3'])).resolves.toBe('failed:configuring');
  });

  test('returns null when no instance has failed', async () => {
    mockSend.mockImplementation(() => Promise.resolve(tagsFor('registered')));
    await expect(aws.getBatchBootstrapStatus(['i-1', 'i-2'])).resolves.toBeNull();
  });
});

describe('getConsoleOutputTail', () => {
  test('decodes base64 and returns the last N lines', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    mockSend.mockResolvedValueOnce({ Output: b64(lines) });
    const tail = await aws.getConsoleOutputTail('i-1', { maxLines: 3 });
    expect(tail).toBe('line8\nline9\nline10');
  });

  test('caps the tail at maxBytes', async () => {
    mockSend.mockResolvedValueOnce({ Output: b64('a'.repeat(1000)) });
    const tail = await aws.getConsoleOutputTail('i-1', { maxLines: 200, maxBytes: 100 });
    expect(tail.length).toBe(100);
  });

  test('redacts secret values from the captured output', async () => {
    const token = 'AAAA-registration-token-BBBB';
    mockSend.mockResolvedValueOnce({ Output: b64(`cloud-init: config.sh --token ${token} done`) });
    const tail = await aws.getConsoleOutputTail('i-1', { redactValues: [token] });
    expect(tail).not.toContain(token);
    expect(tail).toContain('***');
  });

  test('returns empty string when no console output is available', async () => {
    mockSend.mockResolvedValueOnce({ Output: undefined });
    await expect(aws.getConsoleOutputTail('i-1')).resolves.toBe('');
  });

  test('returns empty string when GetConsoleOutput fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    await expect(aws.getConsoleOutputTail('i-1')).resolves.toBe('');
  });
});

describe('handleStartFailure', () => {
  test('captures console output BEFORE terminating (default cleanup)', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd.__command === 'GetConsoleOutput') return Promise.resolve({ Output: b64('boot failed here') });
      return Promise.resolve({});
    });

    await aws.handleStartFailure('i-abc', { redactValues: [] });

    expect(commandsSent()).toEqual(['GetConsoleOutput', 'TerminateInstances']);
    expect(core.startGroup).toHaveBeenCalledTimes(1);
    expect(core.endGroup).toHaveBeenCalledTimes(1);
  });

  test('redacts the registration token from the printed console output', async () => {
    const token = 'AAAA-registration-token-BBBB';
    mockSend.mockImplementation((cmd) => {
      if (cmd.__command === 'GetConsoleOutput') return Promise.resolve({ Output: b64(`log --token ${token} log`) });
      return Promise.resolve({});
    });

    await aws.handleStartFailure('i-abc', { redactValues: [token] });

    const allInfo = core.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allInfo).not.toContain(token);
    expect(allInfo).toContain('***');
  });

  test('preserves the instance and prints a debug command when cleanup is disabled', async () => {
    config.input.cleanupOnStartFailure = 'false';
    mockSend.mockImplementation((cmd) => {
      if (cmd.__command === 'GetConsoleOutput') return Promise.resolve({ Output: b64('x') });
      return Promise.resolve({});
    });

    await aws.handleStartFailure('i-keep', { redactValues: [] });

    expect(commandsSent()).toEqual(['GetConsoleOutput']);
    expect(commandsSent()).not.toContain('TerminateInstances');
    const warnings = core.warning.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnings).toContain('i-keep');
    expect(warnings).toContain('get-console-output');
  });

  test('captures ALL instances then terminates ALL (batch, no half-fleet)', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd.__command === 'GetConsoleOutput') return Promise.resolve({ Output: b64('boot log') });
      return Promise.resolve({});
    });

    await aws.handleStartFailure(['i-1', 'i-2'], { redactValues: [] });

    // Every instance's console captured before any termination.
    expect(commandsSent()).toEqual(['GetConsoleOutput', 'GetConsoleOutput', 'TerminateInstances', 'TerminateInstances']);
    expect(core.startGroup).toHaveBeenCalledTimes(2);
  });

  test('preserves ALL instances when cleanup is disabled (batch)', async () => {
    config.input.cleanupOnStartFailure = 'false';
    mockSend.mockImplementation((cmd) => {
      if (cmd.__command === 'GetConsoleOutput') return Promise.resolve({ Output: b64('x') });
      return Promise.resolve({});
    });

    await aws.handleStartFailure(['i-1', 'i-2'], { redactValues: [] });

    expect(commandsSent()).toEqual(['GetConsoleOutput', 'GetConsoleOutput']);
    const warnings = core.warning.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnings).toContain('i-1');
    expect(warnings).toContain('i-2');
  });

  test('does not throw if termination itself fails after capture', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd.__command === 'GetConsoleOutput') return Promise.resolve({ Output: b64('x') });
      return Promise.reject(new Error('terminate boom'));
    });

    await expect(aws.handleStartFailure('i-abc', { redactValues: [] })).resolves.toBeUndefined();
    const warnings = core.warning.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnings).toContain('i-abc');
  });
});
