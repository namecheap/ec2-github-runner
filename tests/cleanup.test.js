// Tests for the cleanup reaper: the pure decideReap decision matrix, the
// injectable runReaper orchestration, and renderCleanupSummary. log.js is
// reached transitively, so config + core are mocked to keep it quiet.
jest.mock('../src/config', () => ({ input: { mode: 'cleanup', debug: 'false' } }));
jest.mock('@actions/core', () => ({ info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { decideReap, runReaper, renderCleanupSummary, REAP_GRACE_MINUTES } = require('../src/cleanup');

const NOW = Date.parse('2026-07-02T18:00:00.000Z');
const minutesAgo = (m) => NOW - m * 60000;
const opts = { nowMs: NOW, maxAgeMinutes: 120, graceMinutes: REAP_GRACE_MINUTES };

describe('decideReap — decision matrix', () => {
  test('skips instances still within the grace period', () => {
    const d = decideReap({ startedAtMs: minutesAgo(5) }, null, opts);
    expect(d).toMatchObject({ action: 'skip', reason: 'within-grace-period' });
  });

  test('reaps an old instance whose runner is not registered (no deregister)', () => {
    const d = decideReap({ startedAtMs: minutesAgo(200) }, null, opts);
    expect(d).toMatchObject({ action: 'reap', reason: 'runner-not-registered', deregister: false });
  });

  test('never reaps a busy runner, regardless of age', () => {
    const d = decideReap({ startedAtMs: minutesAgo(10000) }, { id: 1, busy: true }, opts);
    expect(d).toMatchObject({ action: 'skip', reason: 'runner-busy' });
  });

  test('reaps and deregisters an idle runner past max-age', () => {
    const d = decideReap({ startedAtMs: minutesAgo(200) }, { id: 1, busy: false }, opts);
    expect(d).toMatchObject({ action: 'reap', reason: 'runner-idle-past-max-age', deregister: true });
  });

  test('skips an idle runner still within max-age', () => {
    const d = decideReap({ startedAtMs: minutesAgo(60) }, { id: 1, busy: false }, opts);
    expect(d).toMatchObject({ action: 'skip', reason: 'runner-idle-within-max-age' });
  });

  test('drains a stopped pool instance older than stopped-max-age', () => {
    const d = decideReap({ startedAtMs: minutesAgo(2000), state: 'stopped' }, null, { ...opts, stoppedMaxAgeMinutes: 1440 });
    expect(d).toMatchObject({ action: 'reap', reason: 'stopped-past-max-age' });
  });

  test('keeps a stopped pool instance within stopped-max-age', () => {
    const d = decideReap({ startedAtMs: minutesAgo(60), state: 'stopped' }, null, { ...opts, stoppedMaxAgeMinutes: 1440 });
    expect(d).toMatchObject({ action: 'skip', reason: 'stopped-within-max-age' });
  });
});

function fixtures() {
  const instances = [
    { instanceId: 'i-a', label: 'a', startedAtMs: minutesAgo(200) }, // runner gone -> reap
    { instanceId: 'i-b', label: 'b', startedAtMs: minutesAgo(200) }, // busy -> skip
    { instanceId: 'i-c', label: 'c', startedAtMs: minutesAgo(200) }, // idle old -> reap + deregister
    { instanceId: 'i-d', label: 'd', startedAtMs: minutesAgo(5) },   // grace -> skip
    { instanceId: 'i-e', label: 'e', startedAtMs: minutesAgo(60) },  // idle young -> skip
  ];
  const runners = { a: null, b: { id: 2, busy: true }, c: { id: 3, busy: false }, d: { id: 4, busy: false }, e: { id: 5, busy: false } };
  return { instances, runners };
}

describe('runReaper', () => {
  test('terminates and deregisters exactly the right instances (live run)', async () => {
    const { instances, runners } = fixtures();
    const terminateInstance = jest.fn().mockResolvedValue();
    const deregisterRunner = jest.fn().mockResolvedValue();

    const summary = await runReaper({
      listManagedInstances: () => Promise.resolve(instances),
      getRunnerByLabel: (l) => Promise.resolve(runners[l]),
      terminateInstance,
      deregisterRunner,
      now: () => NOW,
    }, { maxAgeMinutes: 120, dryRun: false });

    expect(terminateInstance.mock.calls.map((c) => c[0]).sort()).toEqual(['i-a', 'i-c']);
    expect(deregisterRunner.mock.calls.map((c) => c[0])).toEqual([3]); // only the idle-old one
    expect(summary).toMatchObject({ examined: 5, reaped: 2, skipped: 3, dryRun: false });
  });

  test('dry-run acts on nothing but still lists candidates', async () => {
    const { instances, runners } = fixtures();
    const terminateInstance = jest.fn().mockResolvedValue();
    const deregisterRunner = jest.fn().mockResolvedValue();

    const summary = await runReaper({
      listManagedInstances: () => Promise.resolve(instances),
      getRunnerByLabel: (l) => Promise.resolve(runners[l]),
      terminateInstance,
      deregisterRunner,
      now: () => NOW,
    }, { maxAgeMinutes: 120, dryRun: true });

    expect(terminateInstance).not.toHaveBeenCalled();
    expect(deregisterRunner).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ examined: 5, reaped: 2, skipped: 3, dryRun: true });
    expect(summary.rows.filter((r) => r.action === 'reap').every((r) => r.performed === false)).toBe(true);
  });

  test('drains stopped instances without a GitHub runner lookup', async () => {
    const instances = [
      { instanceId: 'i-old', label: 'x', startedAtMs: minutesAgo(2000), state: 'stopped' },
      { instanceId: 'i-fresh', label: 'y', startedAtMs: minutesAgo(30), state: 'stopped' },
    ];
    const terminateInstance = jest.fn().mockResolvedValue();
    const getRunnerByLabel = jest.fn();

    const summary = await runReaper({
      listManagedInstances: () => Promise.resolve(instances),
      getRunnerByLabel,
      terminateInstance,
      deregisterRunner: jest.fn(),
      now: () => NOW,
    }, { maxAgeMinutes: 120, stoppedMaxAgeMinutes: 1440, dryRun: false });

    expect(terminateInstance.mock.calls.map((c) => c[0])).toEqual(['i-old']);
    expect(getRunnerByLabel).not.toHaveBeenCalled(); // stopped instances skip the runner check
    expect(summary).toMatchObject({ examined: 2, reaped: 1, skipped: 1 });
  });

  test('a termination failure is recorded and does not abort the sweep', async () => {
    const instances = [
      { instanceId: 'i-x', label: 'x', startedAtMs: minutesAgo(200) },
      { instanceId: 'i-y', label: 'y', startedAtMs: minutesAgo(200) },
    ];
    const terminateInstance = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce();

    const summary = await runReaper({
      listManagedInstances: () => Promise.resolve(instances),
      getRunnerByLabel: () => Promise.resolve(null),
      terminateInstance,
      deregisterRunner: jest.fn(),
      now: () => NOW,
    }, { maxAgeMinutes: 120, dryRun: false });

    expect(terminateInstance).toHaveBeenCalledTimes(2);
    expect(summary.rows[0]).toMatchObject({ instanceId: 'i-x', error: 'boom' });
    expect(summary.rows[1]).toMatchObject({ instanceId: 'i-y', performed: true });
  });
});

describe('renderCleanupSummary', () => {
  test('renders a dry-run table with "would reap"', () => {
    const md = renderCleanupSummary({
      examined: 1, reaped: 1, skipped: 0, dryRun: true,
      rows: [{ instanceId: 'i-a', label: 'a', action: 'reap', reason: 'runner-not-registered' }],
    });
    expect(md).toContain('dry-run');
    expect(md).toContain('| i-a | a | reap | runner-not-registered | would reap |');
  });

  test('renders a live table distinguishing terminate vs terminate+deregister', () => {
    const md = renderCleanupSummary({
      examined: 2, reaped: 2, skipped: 0, dryRun: false,
      rows: [
        { instanceId: 'i-a', label: 'a', action: 'reap', reason: 'runner-not-registered', performed: true },
        { instanceId: 'i-c', label: 'c', action: 'reap', reason: 'runner-idle-past-max-age', performed: true, deregistered: true },
      ],
    });
    expect(md).toContain('| i-a | a | reap | runner-not-registered | terminated |');
    expect(md).toContain('| i-c | c | reap | runner-idle-past-max-age | terminated + deregistered |');
  });
});
