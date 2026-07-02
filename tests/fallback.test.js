// Tests for the capacity-fallback chain: classifyRunError and the
// launchWithFallback walker. launchWithFallback takes an injected attempt()
// so the ordering logic is tested without the AWS SDK. config + core are
// mocked because aws.js reaches log.js at require time.
jest.mock('../src/config', () => ({
  input: { mode: 'start', debug: 'false' },
  githubContext: { owner: 'o', repo: 'r' },
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setFailed: jest.fn(), getInput: jest.fn(),
  startGroup: jest.fn(), endGroup: jest.fn(),
}));

const { classifyRunError, launchWithFallback } = require('../src/aws');

const err = (name) => Object.assign(new Error(name), { name });
const capacity = () => err('InsufficientInstanceCapacity');

describe('classifyRunError', () => {
  test('capacity codes classify as capacity', () => {
    for (const n of ['InsufficientInstanceCapacity', 'InsufficientHostCapacity', 'Unsupported', 'SpotMaxPriceTooLow']) {
      expect(classifyRunError(err(n))).toBe('capacity');
    }
  });

  test('transient codes classify as transient', () => {
    for (const n of ['RequestLimitExceeded', 'Throttling', 'InternalError', 'ServiceUnavailable']) {
      expect(classifyRunError(err(n))).toBe('transient');
    }
  });

  test('everything else — including quota — classifies as fatal', () => {
    for (const n of ['InvalidAMIID.NotFound', 'UnauthorizedOperation', 'InstanceLimitExceeded', 'InvalidParameterValue']) {
      expect(classifyRunError(err(n))).toBe('fatal');
    }
  });
});

describe('launchWithFallback', () => {
  test('returns on the first cell when it succeeds (no fallback)', async () => {
    const attempt = jest.fn().mockResolvedValue('i-1');
    const result = await launchWithFallback(attempt, ['t1', 't2'], ['s1', 's2']);
    expect(result).toEqual({ instanceId: 'i-1', instanceType: 't1', subnetId: 's1' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test('exhausts all subnets for a type before advancing to the next type', async () => {
    const attempt = jest.fn()
      .mockRejectedValueOnce(capacity()) // t1/s1
      .mockRejectedValueOnce(capacity()) // t1/s2
      .mockResolvedValueOnce('i-9');     // t2/s1
    const result = await launchWithFallback(attempt, ['t1', 't2'], ['s1', 's2']);
    expect(result).toEqual({ instanceId: 'i-9', instanceType: 't2', subnetId: 's1' });
    expect(attempt.mock.calls).toEqual([['t1', 's1'], ['t1', 's2'], ['t2', 's1']]);
  });

  test('walks the full matrix in order and throws a capacity summary on exhaustion', async () => {
    const attempt = jest.fn().mockRejectedValue(capacity());
    await expect(launchWithFallback(attempt, ['t1', 't2'], ['s1', 's2'])).rejects.toMatchObject({ capacityExhausted: true });
    expect(attempt.mock.calls).toEqual([['t1', 's1'], ['t1', 's2'], ['t2', 's1'], ['t2', 's2']]);
    // The summary names every attempted cell + its error code.
    await expect(launchWithFallback(jest.fn().mockRejectedValue(capacity()), ['t1'], ['s1']))
      .rejects.toThrow(/t1\/s1=InsufficientInstanceCapacity/);
  });

  test('aborts immediately on a fatal (non-capacity) error', async () => {
    const attempt = jest.fn()
      .mockRejectedValueOnce(err('InvalidAMIID.NotFound'));
    await expect(launchWithFallback(attempt, ['t1', 't2'], ['s1', 's2'])).rejects.toThrow('InvalidAMIID.NotFound');
    expect(attempt).toHaveBeenCalledTimes(1); // no further cells tried
  });

  test('gives a targeted message for a quota error and stops the chain', async () => {
    const attempt = jest.fn().mockRejectedValueOnce(err('InstanceLimitExceeded'));
    await expect(launchWithFallback(attempt, ['t1', 't2'], ['s1'])).rejects.toThrow(/quota.*InstanceLimitExceeded/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
