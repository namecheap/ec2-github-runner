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
// Maintenance: whenever the `runner-version` default bumps in
// action.yml, add the matching hashes here from the release body at
// https://github.com/actions/runner/releases/tag/v<version>. The
// `verify-runner-url` CI job cross-checks every entry against the
// live release body on every PR, so a drift between this table and
// upstream is caught at code-review time, not at runtime.
//
// Sources:
//   https://github.com/actions/runner/releases/tag/v2.335.1

const CHECKSUMS = {
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
