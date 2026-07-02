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

// Deregister a self-hosted runner by its GitHub runner id. Idempotent
// (DELETE), so it's retried on transient errors.
async function deregisterRunner(runnerId) {
  const octokit = github.getOctokit(config.input.githubToken);
  await withRetry('remove_runner', () =>
    octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', { ...config.githubContext, runner_id: runnerId }),
  );
}

// True once the runner for `label` has registered with GitHub and reports
// as online. Used as the success signal by the start action's wait loop
// (see src/wait.js), polled alongside the instance's bootstrap tag.
async function isRunnerOnline(label) {
  const runner = await getRunner(label);
  log.debug('runner_status', { label, found: !!runner, status: runner ? runner.status : null });
  return !!(runner && runner.status === 'online');
}

// Count how many runners carrying `label` are registered and online. Used by
// the batch wait loop, which succeeds only once all N runners are up.
async function countOnlineRunners(label) {
  const octokit = github.getOctokit(config.input.githubToken);
  try {
    const runners = await octokit.paginate('GET /repos/{owner}/{repo}/actions/runners', config.githubContext);
    const online = runners.filter((r) => r.labels.some((l) => l.name === label) && r.status === 'online');
    log.debug('runner_status', { label, online: online.length });
    return online.length;
  } catch (_error) {
    return 0;
  }
}

// Deregister EVERY runner carrying `label` (a batch registers N runners under
// one shared label). Returns per-runner outcomes; a single failure does not
// abort the rest. Idempotent — no matching runners is a clean no-op.
async function removeAllRunners(label) {
  const octokit = github.getOctokit(config.input.githubToken);
  let runners;
  try {
    const all = await octokit.paginate('GET /repos/{owner}/{repo}/actions/runners', config.githubContext);
    runners = all.filter((r) => r.labels.some((l) => l.name === label));
  } catch (error) {
    throw new Error(`could not list runners for label ${label}: ${error.message}`, { cause: error });
  }

  if (runners.length === 0) {
    log.info('remove_runner', { label, skipped: true, reason: 'not_found' });
    core.info(`No GitHub self-hosted runners found for label ${label}; removal skipped`);
    return { removed: 0, failures: [] };
  }

  const failures = [];
  for (const runner of runners) {
    try {
      await deregisterRunner(runner.id);
      log.info('remove_runner', { runner_id: runner.id, label });
    } catch (error) {
      log.error('remove_runner', { runner_id: runner.id, label, error: error.name, message: error.message });
      failures.push({ runnerId: runner.id, message: error.message });
    }
  }
  core.info(`Removed ${runners.length - failures.length}/${runners.length} GitHub self-hosted runners for label ${label}`);
  return { removed: runners.length - failures.length, failures };
}

module.exports = {
  getRegistrationToken,
  deregisterRunner,
  isRunnerOnline,
  countOnlineRunners,
  removeAllRunners,
  getRunner,
};
