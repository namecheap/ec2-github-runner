const core = require('@actions/core');
const github = require('@actions/github');
const config = require('./config');
const log = require('./log');
const { withRetry } = require('./retry');

// use the unique label to find the runner
// as we don't have the runner's id, it's not possible to get it in any other way
async function getRunner(label) {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    const runners = await octokit.paginate('GET /repos/{owner}/{repo}/actions/runners', config.githubContext);
    const foundRunner = runners.find(r => r.labels.some(l => l.name === label));
    return foundRunner || null;
  } catch (error) {
    return null;
  }
}

// get GitHub Registration Token for registering a self-hosted runner
async function getRegistrationToken() {
  const octokit = github.getOctokit(config.input.githubToken);
  const start = Date.now();
  log.info('gh_registration_token', { ...config.githubContext });

  try {
    const response = await octokit.request('POST /repos/{owner}/{repo}/actions/runners/registration-token', config.githubContext);
    log.info('gh_registration_token', { ...config.githubContext, elapsed_ms: Date.now() - start });
    core.info('GitHub Registration Token is received');
    return response.data.token;
  } catch (error) {
    log.error('gh_registration_token', { error: error.name, message: error.message, status: error.status });
    core.error('GitHub Registration Token receiving error');
    throw error;
  }
}

async function removeRunner() {
  const runner = await getRunner(config.input.label);
  const octokit = github.getOctokit(config.input.githubToken);

  // skip the runner removal process if the runner is not found
  if (!runner) {
    log.info('remove_runner', { label: config.input.label, skipped: true, reason: 'not_found' });
    core.info(`GitHub self-hosted runner with label ${config.input.label} is not found, so the removal is skipped`);
    return;
  }

  const start = Date.now();
  log.info('remove_runner', { runner_id: runner.id, label: config.input.label });
  try {
    await withRetry('remove_runner', () =>
      octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', { ...config.githubContext, runner_id: runner.id }),
    );
    log.info('remove_runner', { runner_id: runner.id, label: config.input.label, elapsed_ms: Date.now() - start });
    core.info(`GitHub self-hosted runner ${runner.name} is removed`);
    return;
  } catch (error) {
    log.error('remove_runner', { runner_id: runner.id, label: config.input.label, error: error.name, message: error.message });
    core.error('GitHub self-hosted runner removal error');
    throw error;
  }
}

async function waitForRunnerRegistered(label) {
  const timeoutMinutes = 5;
  const retryIntervalSeconds = 10;
  const quietPeriodSeconds = 30;
  let waitSeconds = 0;

  core.info(`Waiting ${quietPeriodSeconds}s for the AWS EC2 instance to be registered in GitHub as a new self-hosted runner`);
  await new Promise(r => setTimeout(r, quietPeriodSeconds * 1000));
  core.info(`Checking every ${retryIntervalSeconds}s if the GitHub self-hosted runner is registered`);

  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      const runner = await getRunner(label);
      log.debug('wait_for_runner_poll', { label, elapsed_s: waitSeconds, found: !!runner, status: runner ? runner.status : null });

      if (waitSeconds > timeoutMinutes * 60) {
        log.error('wait_for_runner', { label, timeout_minutes: timeoutMinutes });
        core.error('GitHub self-hosted runner registration error');
        clearInterval(interval);
        reject(`A timeout of ${timeoutMinutes} minutes is exceeded. Your AWS EC2 instance was not able to register itself in GitHub as a new self-hosted runner.`);
      }

      if (runner && runner.status === 'online') {
        log.info('wait_for_runner', { label, runner_id: runner.id, elapsed_s: waitSeconds });
        core.info(`GitHub self-hosted runner ${runner.name} is registered and ready to use`);
        clearInterval(interval);
        resolve();
      } else {
        waitSeconds += retryIntervalSeconds;
        core.info('Checking...');
      }
    }, retryIntervalSeconds * 1000);
  });
}

module.exports = {
  getRegistrationToken,
  removeRunner,
  waitForRunnerRegistered,
};
