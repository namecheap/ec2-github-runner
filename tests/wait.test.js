// Tests for waitForRunnerReady — the combined bootstrap-watch + runner-
// registration loop. All I/O and timing are injected, so these run
// instantly with a no-op sleep and no real AWS/GitHub calls.
jest.mock('@actions/core', () => ({ info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/config', () => ({ input: { mode: 'start', debug: 'false' } }));

const core = require('@actions/core');
const { waitForRunnerReady } = require('../src/wait');

const noSleep = () => Promise.resolve();

beforeEach(() => {
  core.error.mockClear();
  core.warning.mockClear();
});

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

  // Failure-detail capture: a phoned-home value can now be
  // `failed:<step>:<detail>` (see PHONE_HOME_HELPERS in src/aws.js). These
  // cover the JS-side split/surface logic; tests/phone-home-detail.test.js
  // covers the shell side that produces these values for real.
  describe('failure-detail capture (failed:<step>:<detail>)', () => {
    test('surfaces the detail in both the thrown error and error.bootstrapDetail', async () => {
      const getBootstrapStatus = jest.fn().mockResolvedValue('failed:configuring:config.sh failed: Not configured.');
      const isRunnerOnline = jest.fn().mockResolvedValue(false);

      let caught;
      try {
        await waitForRunnerReady({ getBootstrapStatus, isRunnerOnline, sleep: noSleep }, { quietSeconds: 0 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(caught.bootstrapStep).toBe('configuring');
      expect(caught.bootstrapDetail).toBe('config.sh failed: Not configured.');
      expect(caught.message).toContain('"configuring"');
      expect(caught.message).toContain('config.sh failed: Not configured.');
      // The workflow log (core.error) must also carry the detail, not just
      // the thrown error.
      expect(core.error).toHaveBeenCalledWith(expect.stringContaining('config.sh failed: Not configured.'));
    });

    test('a detail snippet containing colons is preserved whole (only the FIRST colon after the prefix is the step/detail boundary)', async () => {
      const getBootstrapStatus = jest.fn().mockResolvedValue('failed:configuring:config.sh: error: Not configured: run config.sh');
      const isRunnerOnline = jest.fn().mockResolvedValue(false);

      await expect(
        waitForRunnerReady({ getBootstrapStatus, isRunnerOnline, sleep: noSleep }, { quietSeconds: 0 }),
      ).rejects.toMatchObject({
        bootstrapStep: 'configuring',
        bootstrapDetail: 'config.sh: error: Not configured: run config.sh',
      });
    });

    test('surfaces whatever detail it is given, even if the tag-value length/newline constraint were somehow violated upstream', async () => {
      // The 256-char/no-newline guarantee is enforced shell-side (see
      // tests/phone-home-detail.test.js for the real end-to-end proof);
      // this only checks that src/wait.js itself never chokes on a
      // pathological value if that guarantee were ever violated.
      const hugeDetail = 'x'.repeat(5000);
      const getBootstrapStatus = jest.fn().mockResolvedValue(`failed:configuring:${hugeDetail}`);
      const isRunnerOnline = jest.fn().mockResolvedValue(false);

      await expect(
        waitForRunnerReady({ getBootstrapStatus, isRunnerOnline, sleep: noSleep }, { quietSeconds: 0 }),
      ).rejects.toMatchObject({ bootstrapStep: 'configuring', bootstrapDetail: hugeDetail });
    });

    test('backward compatible: an old-style "failed:<step>" value with no detail is unaffected', async () => {
      const getBootstrapStatus = jest.fn().mockResolvedValue('failed:downloading');
      const isRunnerOnline = jest.fn().mockResolvedValue(false);

      let caught;
      try {
        await waitForRunnerReady({ getBootstrapStatus, isRunnerOnline, sleep: noSleep }, { quietSeconds: 0 });
      } catch (error) {
        caught = error;
      }

      expect(caught.bootstrapStep).toBe('downloading');
      expect(caught.bootstrapDetail).toBeUndefined();
      // No " — " detail suffix leaks into the message when there is no detail.
      expect(caught.message).toBe('EC2 runner bootstrap failed during the "downloading" step. See the captured console output below.');
    });
  });

  // Stability confirmation (confirmChecks): a single online poll is necessary
  // but not sufficient. On a warm restart the runner can report online on the
  // first poll and then drop before the dependent job is scheduled (issue
  // #67); requiring N CONSECUTIVE online polls turns that flap into a failure
  // here instead of a downstream job queued forever.
  describe('online-stability confirmation (confirmChecks)', () => {
    test('requires confirmChecks consecutive online polls before resolving', async () => {
      const getBootstrapStatus = jest.fn().mockResolvedValue(null);
      const isRunnerOnline = jest.fn().mockResolvedValue(true);

      await waitForRunnerReady(
        { getBootstrapStatus, isRunnerOnline, sleep: noSleep },
        { quietSeconds: 0, intervalSeconds: 1, confirmChecks: 3 },
      );

      // An instant first-poll match is no longer terminal: it must be
      // confirmed by two further consecutive online polls.
      expect(isRunnerOnline).toHaveBeenCalledTimes(3);
    });

    test('a flap resets the streak, so an instant online then offline does not count as ready', async () => {
      const getBootstrapStatus = jest.fn().mockResolvedValue(null);
      // online (streak 1) -> offline (flap, reset) -> online, online, online
      const isRunnerOnline = jest.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      await waitForRunnerReady(
        { getBootstrapStatus, isRunnerOnline, sleep: noSleep },
        { quietSeconds: 0, intervalSeconds: 1, confirmChecks: 3 },
      );

      expect(isRunnerOnline).toHaveBeenCalledTimes(5);
      // The flap is surfaced in the log so the failure mode is debuggable.
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('offline while confirming stability'));
    });

    test('an unstable (perpetually flapping) registration times out rather than resolving', async () => {
      const getBootstrapStatus = jest.fn().mockResolvedValue(null);
      // Alternating online/offline never reaches 3 in a row.
      let poll = 0;
      const isRunnerOnline = jest.fn().mockImplementation(() => Promise.resolve(poll++ % 2 === 0));

      await expect(
        waitForRunnerReady(
          { getBootstrapStatus, isRunnerOnline, sleep: noSleep },
          { quietSeconds: 0, intervalSeconds: 10, timeoutMinutes: 0.5, confirmChecks: 3 },
        ),
      ).rejects.toMatchObject({ timedOut: true });
    });

    test('a bootstrap failure during confirmation still fast-fails', async () => {
      // Online on the first poll (streak 1), then cloud-init phones a failure
      // before the streak completes — the fast-fail must win.
      const getBootstrapStatus = jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('failed:configuring');
      const isRunnerOnline = jest.fn().mockResolvedValue(true);

      await expect(
        waitForRunnerReady(
          { getBootstrapStatus, isRunnerOnline, sleep: noSleep },
          { quietSeconds: 0, intervalSeconds: 1, confirmChecks: 3 },
        ),
      ).rejects.toMatchObject({ bootstrapStep: 'configuring' });
    });

    test('confirmChecks defaults to 1 (legacy accept-first-online)', async () => {
      const getBootstrapStatus = jest.fn().mockResolvedValue(null);
      const isRunnerOnline = jest.fn().mockResolvedValue(true);

      await waitForRunnerReady({ getBootstrapStatus, isRunnerOnline, sleep: noSleep }, { quietSeconds: 0 });

      expect(isRunnerOnline).toHaveBeenCalledTimes(1);
    });
  });
});
