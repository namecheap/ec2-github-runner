// Silence DEP0169 (`url.parse()` deprecation) — the bundled aws-sdk v2
// uses url.parse() internally for endpoint parsing. aws-sdk v2 is in
// maintenance mode so the warning will not be fixed upstream; we use
// trusted EC2 endpoint URLs and migrating to aws-sdk v3 would require
// rewriting the entire action. Intercept at process.emitWarning so we
// only filter this one code and preserve every other warning, including
// any user-installed 'warning' listeners and Node's default formatter.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...rest) {
  const opts = rest[0];
  const code = (typeof opts === 'string') ? rest[1] : (opts && opts.code);
  if (code === 'DEP0169') return;
  return originalEmitWarning.call(process, warning, ...rest);
};

const fs = require('fs');
const os = require('os');
const aws = require('./aws');
const gh = require('./gh');
const config = require('./config');
const log = require('./log');
const core = require('@actions/core');

// Write directly to the $GITHUB_OUTPUT file. The bundled @actions/core
// v1.2.6 still emits the deprecated '::set-output name=X::Y' workflow
// command; GitHub runners now surface that as a warning. Bypass the
// legacy path — modern runners always set GITHUB_OUTPUT.
function setOutput(label, ec2InstanceId) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `label=${label}${os.EOL}ec2-instance-id=${ec2InstanceId}${os.EOL}`);
    return;
  }
  core.setOutput('label', label);
  core.setOutput('ec2-instance-id', ec2InstanceId);
}

async function start() {
  core.startGroup('start-runner');
  try {
    log.debug('start_inputs', config.input); // sanitized inside log.js
    const label = config.generateUniqueLabel();
    const githubRegistrationToken = await gh.getRegistrationToken();
    const ec2InstanceId = await aws.startEc2Instance(label, githubRegistrationToken);
    setOutput(label, ec2InstanceId);
    await aws.waitForInstanceRunning(ec2InstanceId);
    await gh.waitForRunnerRegistered(label);
    log.info('start', { label, instance_id: ec2InstanceId, outcome: 'registered' });
  } finally {
    core.endGroup();
  }
}

async function stop() {
  core.startGroup('stop-runner');
  const failures = [];
  try {
    log.debug('stop_inputs', config.input);

    // Attempt both cleanups independently — neither should short-circuit
    // the other. A GitHub API failure must not prevent EC2 termination
    // (billing) and vice versa. Both have internal retries via
    // withRetry(); catch here is the last line of defense.
    try {
      await aws.terminateEc2Instance();
    } catch (error) {
      failures.push({ step: 'terminate_instance', error: error.name, message: error.message });
    }
    try {
      await gh.removeRunner();
    } catch (error) {
      failures.push({ step: 'remove_runner', error: error.name, message: error.message });
    }

    if (failures.length > 0) {
      log.error('stop', { outcome: 'partial', failures });
      const summary = failures.map((f) => `${f.step}: ${f.message}`).join('; ');
      throw new Error(`stop mode completed with ${failures.length} cleanup failure(s): ${summary}`);
    }
    log.info('stop', { instance_id: config.input.ec2InstanceId, label: config.input.label, outcome: 'ok' });
  } finally {
    core.endGroup();
  }
}

(async function () {
  try {
    config.input.mode === 'start' ? await start() : await stop();
  } catch (error) {
    log.error('fatal', { mode: config.input.mode, error: error.name, message: error.message });
    core.error(error);
    core.setFailed(error.message);
  }
})();
