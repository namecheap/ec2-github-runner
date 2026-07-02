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
  } catch (_error) {
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

// True once the runner for `label` has registered with GitHub and reports
// as online. Used as the success signal by the start action's wait loop
// (see src/wait.js), polled alongside the instance's bootstrap tag.
async function isRunnerOnline(label) {
  const runner = await getRunner(label);
  log.debug('runner_status', { label, found: !!runner, status: runner ? runner.status : null });
  return !!(runner && runner.status === 'online');
}

module.exports = {
  getRegistrationToken,
  removeRunner,
  isRunnerOnline,
};
