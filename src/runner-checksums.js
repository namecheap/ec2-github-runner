// Expected SHA-256 sums for actions/runner tarballs, keyed by
// `${arch}-${version}`.
//
// Why hardcoded: actions/runner doesn't publish per-tarball .sha256
// sidecar files (see ec2-github-runner#20 for the empirical proof —
// `curl -fsSL <tarball>.sha256` returns 404 and killed the Phase 4
// bootstrap under `set -euo pipefail`). Hashes ARE published in the
// release body as HTML-comment-wrapped markdown, but parsing that
// at boot time means an api.github.com round trip on every runner
// start and hits the unauth rate limit quickly at org scale.
//
// Maintenance: this table is bumped automatically. The weekly
// `Bump actions/runner` workflow (.github/workflows/bump-runner.yml)
// opens a PR via `scripts/bump-runner.js`, which adds the matching
// hashes here from the release body at
// https://github.com/actions/runner/releases/tag/v<version> and
// rebuilds dist. For a manual/hotfix bump, run
// `node scripts/bump-runner.js <version>` (no auto-merge — a human
// reviews the PR). The `verify-runner-url` CI job cross-checks every
// entry against the live release body on every PR, so a drift between
// this table and upstream is caught at code-review time, not at runtime.
//
// Sources:
//   https://github.com/actions/runner/releases/tag/v2.336.0
//   https://github.com/actions/runner/releases/tag/v2.335.1

const CHECKSUMS = {
  'x64-2.336.0':   '04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d',
  'arm64-2.336.0': '58b758e420b87093fbd4bfddd368074960053e2f1388f01848c82624b90f27d1',
  // v2.335.1 — pinned default as of 2026-06-17. Bumped from 2.333.1, which
  // GitHub stops allowing to run jobs on 2026-06-23.
  'x64-2.335.1':   '4ef2f25285f0ae4477f1fe1e346db76d2f3ebf03824e2ddd1973a2819bf6c8cf',
  'arm64-2.335.1': '6d1e85bfd1a506a8b17c1f1b9b57dba458ffed90898799aaa9f599520b0d9207',
};

function lookup(arch, version) {
  return CHECKSUMS[`${arch}-${version}`] || null;
}

module.exports = {
  CHECKSUMS,
  lookup,
};
