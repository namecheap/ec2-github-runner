// retry.js exposes withRetry(step, fn, opts). Tests stub @actions/core
// (via log.js) so the warn/error hooks don't actually hit the Actions
// runtime, and use short base delays so the backoff waits don't blow
// up test time.

const coreMock = {
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
};

function load() {
  jest.resetModules();
  coreMock.info.mockReset();
  coreMock.warning.mockReset();
  coreMock.error.mockReset();
  jest.doMock('@actions/core', () => coreMock);
  jest.doMock('../src/config', () => ({ input: { mode: 'stop', debug: 'false' } }));
  return require('../src/retry');
}

describe('withRetry', () => {
  test('resolves when fn succeeds on first try', async () => {
    const { withRetry } = load();
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry('test_step', fn, { baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(coreMock.warning).not.toHaveBeenCalled();
  });

  test('retries on rejection and resolves when a later attempt succeeds', async () => {
    const { withRetry } = load();
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ok');
    await expect(withRetry('test_step', fn, { attempts: 3, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(coreMock.warning).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(coreMock.warning.mock.calls[0][0]);
    expect(payload).toMatchObject({ step: 'test_step_retry', attempt: 1, attempts: 3 });
  });

  test('exhausts attempts and re-throws the last error', async () => {
    const { withRetry } = load();
    const fn = jest.fn().mockRejectedValue(new Error('persistent'));
    await expect(withRetry('test_step', fn, { attempts: 3, baseMs: 1 })).rejects.toThrow('persistent');
    expect(fn).toHaveBeenCalledTimes(3);
    // Two warn logs (attempts 1 and 2) + one error log (attempt 3 exhausted).
    expect(coreMock.warning).toHaveBeenCalledTimes(2);
    expect(coreMock.error).toHaveBeenCalledTimes(1);
    const final = JSON.parse(coreMock.error.mock.calls[0][0]);
    expect(final).toMatchObject({ step: 'test_step_retry', attempt: 3, exhausted: true });
  });

  test('shouldRetry:false re-throws immediately without retrying', async () => {
    const { withRetry } = load();
    const fatal = Object.assign(new Error('bad config'), { name: 'InvalidAMIID.NotFound' });
    const fn = jest.fn().mockRejectedValue(fatal);
    await expect(
      withRetry('test_step', fn, { attempts: 3, baseMs: 1, shouldRetry: () => false }),
    ).rejects.toThrow('bad config');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(coreMock.warning).not.toHaveBeenCalled();
  });

  test('shouldRetry:true keeps retrying (default behavior preserved)', async () => {
    const { withRetry } = load();
    const fn = jest.fn().mockRejectedValueOnce(new Error('t')).mockResolvedValue('ok');
    await expect(
      withRetry('test_step', fn, { attempts: 3, baseMs: 1, shouldRetry: () => true }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('backoff caps at maxMs', async () => {
    const { withRetry } = load();
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockRejectedValueOnce(new Error('e3'))
      .mockResolvedValue('ok');
    await expect(withRetry('test_step', fn, { attempts: 5, baseMs: 100, maxMs: 150 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
    // Delays emitted in warn logs: 100, 150, 150 (capped).
    const delays = coreMock.warning.mock.calls.map((c) => JSON.parse(c[0]).next_delay_ms);
    expect(delays).toEqual([100, 150, 150]);
  });
});
