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
const { waitForRunnerReady } = require('./wait');
const { runReaper, renderCleanupSummary, REAP_GRACE_MINUTES } = require('./cleanup');
const { parseCsv } = require('./utils');
const core = require('@actions/core');

// Write directly to the $GITHUB_OUTPUT file. The bundled @actions/core
// v1.2.6 still emits the deprecated '::set-output name=X::Y' workflow
// command; GitHub runners now surface that as a warning. Bypass the
// legacy path — modern runners always set GITHUB_OUTPUT.
function setOutput(label, placement) {
  const { instanceIds, instanceType, subnetId, marketType } = placement;
  // Compat scalar: the first instance id. Batch consumers use the JSON array.
  const firstId = instanceIds[0];
  const idsJson = JSON.stringify(instanceIds);
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(
      outputFile,
      `label=${label}${os.EOL}ec2-instance-id=${firstId}${os.EOL}ec2-instance-ids=${idsJson}${os.EOL}instance-type-used=${instanceType}${os.EOL}subnet-id-used=${subnetId}${os.EOL}market-type-used=${marketType}${os.EOL}`,
    );
    return;
  }
  core.setOutput('label', label);
  core.setOutput('ec2-instance-id', firstId);
  core.setOutput('ec2-instance-ids', idsJson);
  core.setOutput('instance-type-used', instanceType);
  core.setOutput('subnet-id-used', subnetId);
  core.setOutput('market-type-used', marketType);
}

// How many consecutive online polls the wait loop must observe before it
// declares the runner ready (see waitForRunnerReady's confirmChecks). Warm
// restarts get a longer confirmation window: a reused instance can re-register
// and report online on the very first poll and then drop before the dependent
// job is scheduled, which strands that job in `queued` forever (issue #67).
// Cold launches also confirm (one extra poll) to shrink the same flap window
// on a fresh registration.
const WARM_CONFIRM_CHECKS = 3;
const COLD_CONFIRM_CHECKS = 2;

// Warm-pool fast path: reuse a stopped pool instance (count 1 only). Returns
// a placement, or null to fall back to a cold launch (empty pool or a failed
// start — the cold launch then joins the pool).
async function tryWarmStart(label, githubRegistrationToken) {
  const repo = `${config.githubContext.owner}/${config.githubContext.repo}`;
  const instanceType = parseCsv(config.input.ec2InstanceType)[0];
  const pool = await aws.findStoppedPoolInstance({
    repo,
    poolTag: config.input.reusePoolTag,
    instanceType,
    architecture: config.input.architecture,
  });
  if (!pool) {
    log.info('warm_start', { outcome: 'pool_empty', pool: config.input.reusePoolTag });
    return null;
  }
  try {
    const userData = aws.buildReuseUserData(label, githubRegistrationToken);
    await aws.warmStartInstance(pool.instanceId, { userData, label });
    return { instanceIds: [pool.instanceId], instanceType, subnetId: pool.subnetId, marketType: 'reused' };
  } catch (error) {
    log.warn('warm_start', { instance_id: pool.instanceId, error: error.name, message: error.message });
    core.warning(`Warm start of ${pool.instanceId} failed (${error.message}); cold-launching instead`);
    return null;
  }
}

async function start() {
  core.startGroup('start-runner');
  try {
    log.debug('start_inputs', config.input); // sanitized inside log.js
    const label = config.generateUniqueLabel();
    const githubRegistrationToken = await gh.getRegistrationToken();

    // Warm pool: reuse a stopped instance when reuse:stop and count 1;
    // otherwise (or on empty pool / failed reuse) cold-launch.
    let placement = null;
    if (config.input.reuse === 'stop' && Number(config.input.count) === 1) {
      placement = await tryWarmStart(label, githubRegistrationToken);
    }
    if (!placement) {
      placement = await aws.startEc2Instance(label, githubRegistrationToken);
    }
    const instanceIds = placement.instanceIds;
    setOutput(label, placement);
    for (const id of instanceIds) {
      await aws.waitForInstanceRunning(id);
    }

    // Watch the bootstrap phone-home tags and GitHub registration together.
    // The batch is ready only when ALL N runners are online; a bootstrap
    // failure on ANY instance fails fast. Registration must hold online for
    // confirmChecks consecutive polls so a warm restart's flap (issue #67)
    // fails here rather than stranding the downstream job. On failure or
    // timeout, capture the console output of every instance and (by default)
    // terminate them all — no half-fleet is left leaking billing. The token
    // is redacted.
    const warmRestart = placement.marketType === 'reused';
    try {
      await waitForRunnerReady({
        getBootstrapStatus: () => aws.getBatchBootstrapStatus(instanceIds),
        isRunnerOnline: async () => (await gh.countOnlineRunners(label)) >= instanceIds.length,
      }, {
        confirmChecks: warmRestart ? WARM_CONFIRM_CHECKS : COLD_CONFIRM_CHECKS,
      });
    } catch (waitError) {
      await aws.handleStartFailure(instanceIds, { redactValues: [githubRegistrationToken] });
      throw waitError;
    }
    log.info('start', { label, instance_ids: instanceIds, instance_type: placement.instanceType, subnet_id: placement.subnetId, outcome: 'registered' });
  } finally {
    core.endGroup();
  }
}

async function stop() {
  core.startGroup('stop-runner');
  const failures = [];
  try {
    log.debug('stop_inputs', config.input);

    // Terminate every instance from the batch (the JSON array), or the single
    // compat scalar. Independent per instance — one failure doesn't stop the
    // rest — and idempotent: an already-gone instance is not a failure.
    const instanceIds = (config.input.ec2InstanceIds && config.input.ec2InstanceIds.length)
      ? config.input.ec2InstanceIds
      : [config.input.ec2InstanceId];

    const reuse = config.input.reuse === 'stop';
    const maxCycles = Number(config.input.reuseMaxCycles);
    for (const id of instanceIds) {
      try {
        if (reuse) {
          // Warm pool: stop for reuse until the instance has served
          // reuse-max-cycles jobs, then recycle it (terminate).
          const cycles = await aws.getInstanceCycles(id);
          if (cycles + 1 >= maxCycles) {
            log.info('reuse', { instance_id: id, action: 'terminate', reason: 'max_cycles_reached', cycles });
            await aws.terminateInstanceById(id);
          } else {
            await aws.setInstanceCycles(id, cycles + 1);
            await aws.stopInstanceById(id);
          }
        } else {
          await aws.terminateInstanceById(id);
        }
      } catch (error) {
        if (error.name && error.name.includes('NotFound')) {
          log.info('terminate_instance', { instance_id: id, skipped: true, reason: 'already_gone' });
        } else {
          failures.push({ step: `${reuse ? 'stop' : 'terminate'}_instance:${id}`, error: error.name, message: error.message });
        }
      }
    }

    // Deregister ALL runners sharing the label (a batch registers N). A
    // GitHub failure must not have prevented the terminations above.
    try {
      const result = await gh.removeAllRunners(config.input.label);
      for (const f of result.failures) {
        failures.push({ step: `remove_runner:${f.runnerId}`, message: f.message });
      }
    } catch (error) {
      failures.push({ step: 'remove_runner', error: error.name, message: error.message });
    }

    if (failures.length > 0) {
      log.error('stop', { outcome: 'partial', failures });
      const summary = failures.map((f) => `${f.step}: ${f.message}`).join('; ');
      throw new Error(`stop mode completed with ${failures.length} cleanup failure(s): ${summary}`);
    }
    log.info('stop', { instance_ids: instanceIds, label: config.input.label, outcome: 'ok' });
  } finally {
    core.endGroup();
  }
}

// Write the reaper's job-summary table to $GITHUB_STEP_SUMMARY (the
// documented mechanism) and echo it to the log so it's visible even when
// the summary file isn't set (e.g. local runs).
function writeJobSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    fs.appendFileSync(summaryFile, `${markdown}${os.EOL}`);
  }
  core.info(markdown);
}

async function cleanup() {
  core.startGroup('cleanup-runners');
  try {
    const repo = `${config.githubContext.owner}/${config.githubContext.repo}`;
    const dryRun = config.input.dryRun === 'true';
    log.info('cleanup', { repo, max_age_minutes: config.input.maxAgeMinutes, dry_run: dryRun });

    const summary = await runReaper(
      {
        // Include stopped instances so idle warm-pool instances are drained.
        listManagedInstances: () => aws.listManagedInstances(repo, ['pending', 'running', 'stopped']),
        getRunnerByLabel: (label) => gh.getRunner(label),
        terminateInstance: (id) => aws.terminateInstanceById(id),
        deregisterRunner: (runnerId) => gh.deregisterRunner(runnerId),
        now: () => Date.now(),
      },
      {
        maxAgeMinutes: Number(config.input.maxAgeMinutes),
        graceMinutes: REAP_GRACE_MINUTES,
        stoppedMaxAgeMinutes: Number(config.input.reaperStoppedMaxAge),
        dryRun,
      },
    );

    writeJobSummary(renderCleanupSummary(summary));
    log.info('cleanup', { outcome: 'ok', examined: summary.examined, reaped: summary.reaped, skipped: summary.skipped, dry_run: dryRun });
  } finally {
    core.endGroup();
  }
}

(async function () {
  try {
    if (config.input.mode === 'start') {
      await start();
    } else if (config.input.mode === 'stop') {
      await stop();
    } else {
      await cleanup();
    }
  } catch (error) {
    log.error('fatal', { mode: config.input.mode, error: error.name, message: error.message });
    core.error(error);
    core.setFailed(error.message);
  }
})();
