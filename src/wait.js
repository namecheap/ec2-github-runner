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
//   2. GitHub runner registration. Success is authoritative here: the runner
//      showing up as `online` is what lets downstream jobs run.
//
// All I/O and timing are injected so the loop is unit-testable without real
// AWS/GitHub calls or wall-clock sleeps:
//   - deps.getBootstrapStatus(): Promise<string|null>
//   - deps.isRunnerOnline():     Promise<boolean>
//   - deps.sleep(ms):            Promise<void> (defaults to setTimeout)
//
// Throws on `failed:<step>` (err.bootstrapStep set) or on timeout
// (err.timedOut set) so the caller can capture diagnostics and clean up.
async function waitForRunnerReady(deps, opts = {}) {
  const { getBootstrapStatus, isRunnerOnline } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const timeoutMinutes = opts.timeoutMinutes ?? 5;
  const intervalSeconds = opts.intervalSeconds ?? 10;
  const quietSeconds = opts.quietSeconds ?? 30;

  core.info(`Waiting ${quietSeconds}s for the AWS EC2 instance to bootstrap and register as a self-hosted runner`);
  await sleep(quietSeconds * 1000);
  core.info(`Checking every ${intervalSeconds}s for bootstrap failures and runner registration`);

  const deadlineSeconds = timeoutMinutes * 60;
  let waitedSeconds = 0;

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

    // 2. Success when the runner has registered and is online.
    if (await isRunnerOnline()) {
      log.info('wait_for_runner', { outcome: 'online', elapsed_s: waitedSeconds });
      core.info('GitHub self-hosted runner is registered and ready to use');
      return;
    }

    // 3. Bounded wait — give up after the timeout.
    if (waitedSeconds >= deadlineSeconds) {
      log.error('wait_for_runner', { outcome: 'timeout', timeout_minutes: timeoutMinutes });
      const error = new Error(
        `A timeout of ${timeoutMinutes} minutes is exceeded. Your AWS EC2 instance was not able to register itself in GitHub as a new self-hosted runner.`,
      );
      error.timedOut = true;
      throw error;
    }

    log.debug('wait_for_runner_poll', { elapsed_s: waitedSeconds, bootstrap: status || null });
    core.info('Checking...');
    await sleep(intervalSeconds * 1000);
    waitedSeconds += intervalSeconds;
  }
}

module.exports = {
  waitForRunnerReady,
  FAILED_PREFIX,
};
