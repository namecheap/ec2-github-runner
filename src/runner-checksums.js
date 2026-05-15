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
//   https://github.com/actions/runner/releases/tag/v2.333.1

const CHECKSUMS = {
  // v2.333.1 — pinned default as of 2026-04-21.
  'x64-2.333.1':   '18f8f68ed1892854ff2ab1bab4fcaa2f5abeedc98093b6cb13638991725cab74',
  'arm64-2.333.1': '69ac7e5692f877189e7dddf4a1bb16cbbd6425568cd69a0359895fac48b9ad3b',
};

function lookup(arch, version) {
  return CHECKSUMS[`${arch}-${version}`] || null;
}

module.exports = {
  CHECKSUMS,
  lookup,
};
