// Tests for waitForRunnerReady — the combined bootstrap-watch + runner-
// registration loop. All I/O and timing are injected, so these run
// instantly with a no-op sleep and no real AWS/GitHub calls.
jest.mock('@actions/core', () => ({ info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/config', () => ({ input: { mode: 'start', debug: 'false' } }));

const { waitForRunnerReady } = require('../src/wait');

const noSleep = () => Promise.resolve();

describe('waitForRunnerReady', () => {
  test('resolves as soon as the runner is online', async () => {
    const getBootstrapStatus = jest.fn().mockResolvedValue(null);
    const isRunnerOnline = jest.fn().mockResolvedValue(true);

    await expect(
      waitForRunnerReady({ getBootstrapStatus, isRunnerOnline, sleep: noSleep }, { quietSeconds: 0 }),
    ).resolves.toBeUndefined();

    expect(isRunnerOnline).toHaveBeenCalledTimes(1);
  });

  test('resolves after the runner comes online on a later poll', async () => {
    const getBootstrapStatus = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('downloading')
      .mockResolvedValueOnce('configuring');
    const isRunnerOnline = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await waitForRunnerReady({ getBootstrapStatus, isRunnerOnline, sleep: noSleep }, { quietSeconds: 0, intervalSeconds: 1 });

    expect(isRunnerOnline).toHaveBeenCalledTimes(3);
  });

  test('fails fast on a failed:<step> bootstrap tag, naming the step', async () => {
    const getBootstrapStatus = jest.fn().mockResolvedValue('failed:configuring');
    const isRunnerOnline = jest.fn().mockResolvedValue(false);

    await expect(
      waitForRunnerReady({ getBootstrapStatus, isRunnerOnline, sleep: noSleep }, { quietSeconds: 0 }),
    ).rejects.toMatchObject({ bootstrapStep: 'configuring' });

    // Fast-fail happens before the registration check on that poll.
    expect(isRunnerOnline).not.toHaveBeenCalled();
  });

  test('surfaces the failing step name in the error message', async () => {
    const getBootstrapStatus = jest.fn().mockResolvedValue('failed:downloading');
    const isRunnerOnline = jest.fn().mockResolvedValue(false);

    await expect(
      waitForRunnerReady({ getBootstrapStatus, isRunnerOnline, sleep: noSleep }, { quietSeconds: 0 }),
    ).rejects.toThrow(/"downloading"/);
  });

  test('times out when the runner never registers', async () => {
    const getBootstrapStatus = jest.fn().mockResolvedValue(null);
    const isRunnerOnline = jest.fn().mockResolvedValue(false);

    await expect(
      waitForRunnerReady(
        { getBootstrapStatus, isRunnerOnline, sleep: noSleep },
        { quietSeconds: 0, intervalSeconds: 10, timeoutMinutes: 0.5 },
      ),
    ).rejects.toMatchObject({ timedOut: true });
  });

  test('does not treat a non-failed bootstrap tag as an error', async () => {
    const getBootstrapStatus = jest.fn().mockResolvedValue('registered');
    const isRunnerOnline = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(
      waitForRunnerReady({ getBootstrapStatus, isRunnerOnline, sleep: noSleep }, { quietSeconds: 0, intervalSeconds: 1 }),
    ).resolves.toBeUndefined();
  });
});
