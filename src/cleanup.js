const log = require('./log');

// Instances younger than this are never reaped, even if no runner is
// registered for them yet — they may be in-flight starts still working
// through the bootstrap/registration window. Keeps the reaper safe to run
// concurrently with `mode: start`.
const REAP_GRACE_MINUTES = 15;

// Decide what to do with a single managed instance given its matching
// GitHub runner (or null if none is registered). Pure function — no I/O —
// so the full decision matrix is unit-testable.
//
//   stopped, older than stopped-max-age -> reap  (drain idle warm pool)
//   stopped, within stopped-max-age      -> skip
//   within grace period         -> skip  (protect in-flight starts)
//   no runner registered        -> reap  (leaked instance)
//   runner busy                 -> skip  (job in progress, any age)
//   runner idle, older than max -> reap + deregister
//   runner idle, within max age  -> skip
function decideReap(instance, runner, opts) {
  const { nowMs, maxAgeMinutes, graceMinutes, stoppedMaxAgeMinutes } = opts;
  const ageMinutes = instance.startedAtMs != null ? (nowMs - instance.startedAtMs) / 60000 : Infinity;

  // Stopped warm-pool instances: drain those older than the stopped max-age
  // so pools don't accrete EBS cost forever. No runner check — it's stopped.
  if (instance.state === 'stopped') {
    if (stoppedMaxAgeMinutes != null && ageMinutes > stoppedMaxAgeMinutes) {
      return { action: 'reap', reason: 'stopped-past-max-age', deregister: false };
    }
    return { action: 'skip', reason: 'stopped-within-max-age', deregister: false };
  }

  if (ageMinutes < graceMinutes) {
    return { action: 'skip', reason: 'within-grace-period', deregister: false };
  }
  if (!runner) {
    return { action: 'reap', reason: 'runner-not-registered', deregister: false };
  }
  if (runner.busy) {
    return { action: 'skip', reason: 'runner-busy', deregister: false };
  }
  if (ageMinutes > maxAgeMinutes) {
    return { action: 'reap', reason: 'runner-idle-past-max-age', deregister: true };
  }
  return { action: 'skip', reason: 'runner-idle-within-max-age', deregister: false };
}

// Walk every managed instance in the repo, decide, and (unless dryRun)
// terminate + deregister the ones that should be reaped. All AWS/GitHub
// I/O and the clock are injected via deps so the orchestration is
// testable end-to-end with mocks:
//   deps.listManagedInstances(): Promise<Array<{instanceId,label,startedAtMs}>>
//   deps.getRunnerByLabel(label): Promise<runner|null>
//   deps.terminateInstance(id): Promise<void>
//   deps.deregisterRunner(runnerId): Promise<void>
//   deps.now(): number (ms)
// A single instance failing to terminate/deregister is recorded on its row
// and does not abort the sweep.
async function runReaper(deps, opts = {}) {
  const { listManagedInstances, getRunnerByLabel, terminateInstance, deregisterRunner, now } = deps;
  const maxAgeMinutes = opts.maxAgeMinutes;
  const graceMinutes = opts.graceMinutes ?? REAP_GRACE_MINUTES;
  const stoppedMaxAgeMinutes = opts.stoppedMaxAgeMinutes;
  const dryRun = !!opts.dryRun;

  const instances = await listManagedInstances();
  const nowMs = now();
  const rows = [];
  let reaped = 0;
  let skipped = 0;

  for (const instance of instances) {
    // Stopped instances have no live runner to cross-check.
    const runner = (instance.state !== 'stopped' && instance.label) ? await getRunnerByLabel(instance.label) : null;
    const decision = decideReap(instance, runner, { nowMs, maxAgeMinutes, graceMinutes, stoppedMaxAgeMinutes });
    const row = {
      instanceId: instance.instanceId,
      label: instance.label,
      action: decision.action,
      reason: decision.reason,
      performed: false,
    };

    if (decision.action === 'reap') {
      reaped += 1;
      if (!dryRun) {
        try {
          await terminateInstance(instance.instanceId);
          row.performed = true;
          if (decision.deregister && runner) {
            try {
              await deregisterRunner(runner.id);
              row.deregistered = true;
            } catch (error) {
              row.deregisterError = error.message;
              log.error('reaper_deregister', { instance_id: instance.instanceId, runner_id: runner.id, error: error.name, message: error.message });
            }
          }
        } catch (error) {
          row.error = error.message;
          log.error('reaper_terminate', { instance_id: instance.instanceId, error: error.name, message: error.message });
        }
      }
    } else {
      skipped += 1;
    }

    log.info('reaper_decision', { instance_id: instance.instanceId, label: instance.label, action: decision.action, reason: decision.reason, dry_run: dryRun });
    rows.push(row);
  }

  return { examined: instances.length, reaped, skipped, dryRun, rows };
}

// Render the reaper result as a GitHub Actions job-summary markdown table.
function renderCleanupSummary(summary) {
  const heading = summary.dryRun ? 'EC2 runner cleanup (dry-run)' : 'EC2 runner cleanup';
  const lines = [
    `### ${heading}`,
    '',
    `Examined: **${summary.examined}** · Reaped: **${summary.reaped}** · Skipped: **${summary.skipped}**`,
    '',
    '| Instance | Label | Action | Reason | Result |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of summary.rows) {
    let result;
    if (r.action !== 'reap') {
      result = '—';
    } else if (summary.dryRun) {
      result = 'would reap';
    } else if (r.error) {
      result = `error: ${r.error}`;
    } else if (r.deregistered) {
      result = 'terminated + deregistered';
    } else {
      result = 'terminated';
    }
    lines.push(`| ${r.instanceId} | ${r.label || '—'} | ${r.action} | ${r.reason} | ${result} |`);
  }
  return lines.join('\n');
}

module.exports = {
  decideReap,
  runReaper,
  renderCleanupSummary,
  REAP_GRACE_MINUTES,
};
