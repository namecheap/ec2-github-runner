const core = require('@actions/core');
const log = require('./log');

// Terminal bootstrap phone-home states carry a `failed:<step>` value, or
// `failed:<step>:<detail>` when the failing command's stderr was captured
// (see PHONE_HOME_HELPERS / gh_runner_phone_home_failed() in src/aws.js).
// Step names never contain ':', so the FIRST ':' after this prefix is the
// step/detail boundary — safe even when <detail> itself contains colons
// (e.g. a captured "config.sh: error: ..." line). A value with no second
// ':' is the old/no-detail shape and is fully backward compatible.
const FAILED_PREFIX = 'failed:';

// Wait for the EC2 runner to come online, watching two signals in lockstep:
//
//   1. The instance's `ec2-github-runner:bootstrap` phone-home tag. A
//      `failed:<step>` value means cloud-init aborted — fail fast within one
//      poll interval, naming the step, instead of waiting out the full
//      registration timeout.
//   2. GitHub runner registration. Success requires the runner to report
//      `online` on `confirmChecks` CONSECUTIVE polls, not just once — a
//      single online observation is necessary but not sufficient. On a warm
//      restart (reuse:stop) the runner can report online on the very first
//      poll (elapsed_s=0) and then drop before the dependent job is even
//      scheduled; the job then sits queued forever and the consumer's
//      gated stop job never fires, leaking a running instance and its EIP
//      (see issue #67). Confirming the registration stays online turns that
//      flap into a start-step failure the caller can act on, instead of a
//      false success.
//
// All I/O and timing are injected so the loop is unit-testable without real
// AWS/GitHub calls or wall-clock sleeps:
//   - deps.getBootstrapStatus(): Promise<string|null>
//   - deps.isRunnerOnline():     Promise<boolean>
//   - deps.sleep(ms):            Promise<void> (defaults to setTimeout)
//
// opts.confirmChecks (default 1) is how many consecutive online polls are
// required before success. 1 keeps the legacy accept-first-online behaviour;
// the start action passes a higher value on warm restarts (see src/index.js).
//
// Throws on `failed:<step>` (err.bootstrapStep set) or on timeout
// (err.timedOut set) so the caller can capture diagnostics and clean up.
async function waitForRunnerReady(deps, opts = {}) {
  const { getBootstrapStatus, isRunnerOnline } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const timeoutMinutes = opts.timeoutMinutes ?? 5;
  const intervalSeconds = opts.intervalSeconds ?? 10;
  const quietSeconds = opts.quietSeconds ?? 30;
  const confirmChecks = Math.max(1, opts.confirmChecks ?? 1);

  core.info(`Waiting ${quietSeconds}s for the AWS EC2 instance to bootstrap and register as a self-hosted runner`);
  await sleep(quietSeconds * 1000);
  core.info(`Checking every ${intervalSeconds}s for bootstrap failures and runner registration`);

  const deadlineSeconds = timeoutMinutes * 60;
  let waitedSeconds = 0;
  // Count of consecutive polls that observed the runner online. Resets to 0
  // on any poll that does not (a flap), so only a sustained registration
  // reaches confirmChecks.
  let onlineStreak = 0;

  for (;;) {
    // 1. Fast-fail on a phoned-home bootstrap failure.
    const status = await getBootstrapStatus();
    if (typeof status === 'string' && status.startsWith(FAILED_PREFIX)) {
      const rest = status.slice(FAILED_PREFIX.length);
      const sepIndex = rest.indexOf(':');
      const step = sepIndex === -1 ? rest : rest.slice(0, sepIndex);
      const detail = sepIndex === -1 ? '' : rest.slice(sepIndex + 1);
      const detailSuffix = detail ? ` — ${detail}` : '';
      log.error('wait_for_runner', { outcome: 'bootstrap_failed', step, detail: detail || null });
      core.error(`EC2 runner bootstrap failed during the "${step}" step${detailSuffix}`);
      const error = new Error(`EC2 runner bootstrap failed during the "${step}" step${detailSuffix}. See the captured console output below.`);
      error.bootstrapStep = step;
      if (detail) {
        error.bootstrapDetail = detail;
      }
      throw error;
    }

    // 2. Success requires confirmChecks CONSECUTIVE online observations, so a
    //    registration that flaps offline within seconds (the issue-#67 warm-
    //    restart race) never counts as ready.
    if (await isRunnerOnline()) {
      onlineStreak += 1;
      if (onlineStreak >= confirmChecks) {
        log.info('wait_for_runner', { outcome: 'online', elapsed_s: waitedSeconds, confirm_checks: confirmChecks });
        core.info('GitHub self-hosted runner is registered and ready to use');
        return;
      }
      log.debug('wait_for_runner_confirm', { elapsed_s: waitedSeconds, streak: onlineStreak, needed: confirmChecks });
      core.info(`GitHub self-hosted runner is online; confirming stability (${onlineStreak}/${confirmChecks})`);
    } else if (onlineStreak > 0) {
      // The runner was online on a prior poll and now isn't: the registration
      // flapped. Reset the streak and surface it — on the warm-restart path
      // this is the only instance-side-adjacent evidence in the workflow log.
      log.warn('wait_for_runner', { outcome: 'flap', elapsed_s: waitedSeconds, confirmed: onlineStreak, needed: confirmChecks });
      core.warning('GitHub self-hosted runner went offline while confirming stability; continuing to wait for a stable registration');
      onlineStreak = 0;
    }

    // 3. Bounded wait — give up after the timeout.
    if (waitedSeconds >= deadlineSeconds) {
      log.error('wait_for_runner', { outcome: 'timeout', timeout_minutes: timeoutMinutes, confirm_checks: confirmChecks, online_streak: onlineStreak });
      const error = new Error(
        `A timeout of ${timeoutMinutes} minutes is exceeded. Your AWS EC2 instance was not able to register itself in GitHub as a new self-hosted runner.`,
      );
      error.timedOut = true;
      throw error;
    }

    log.debug('wait_for_runner_poll', { elapsed_s: waitedSeconds, bootstrap: status || null, online_streak: onlineStreak });
    core.info('Checking...');
    await sleep(intervalSeconds * 1000);
    waitedSeconds += intervalSeconds;
  }
}

module.exports = {
  waitForRunnerReady,
  FAILED_PREFIX,
};
