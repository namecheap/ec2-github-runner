# Changelog

All notable changes to this action are documented here. This project follows
[Semantic Versioning](https://semver.org/). The moving major tag (e.g. `v4`)
always points at the latest release in that major line.

## [Unreleased]

## [4.0.3] - 2026-09-18

Housekeeping: a newer bundled runner, and every open Dependabot and
code-scanning alert closed. No behaviour change to the action's inputs or
outputs.

### Fixed

- **Default `actions/runner` bumped to 2.337.0** (#70, #75, via `bump-runner`).
  A launch that does not pin `runner-version` gets the newer agent and its
  pinned-checksum verification.

### Security

- **Dependabot and code-scanning alerts resolved** (#74). Transitive dev
  dependency `js-yaml` 3.14.2 -> 3.15.1 (GHSA-5p4m-2wfm-xmqj,
  GHSA-52cp-r559-cp3m, GHSA-h67p-54hq-rp68), and a least-privilege
  `permissions: contents: read` block on the PR workflow. Both are outside the
  bundle: `dist/` rebuilt byte-identical.
- `undici` 6.27.0 -> 6.28.0 (#71) and `brace-expansion` (#72).

### Documentation

- **Security policy** (#73): how to report a vulnerability, and which versions
  are supported.

### Internal

- Dev-dependency bumps: `browserslist` 4.28.2 -> 4.28.9 (#77), `js-yaml`
  3.15.1 -> 3.15.2 (#78).

## [4.0.2] - 2026-07-10

### Fixed

- **`mode: stop` returned before the instance had stopped** (#69): the stop step
  issued `StopInstances` and returned, so a warm pool's next start could race a
  still-stopping instance. It now waits for the `stopped` state.
- **Warm-restart registration race** (#67): on a `reuse: stop` warm restart the
  runner could re-register and report `online` on the very first poll
  (`elapsed_s=0`) and then drop before the dependent job was scheduled — the
  start step exited green, the job sat `queued` forever, and the gated `stop`
  job never fired, leaking a running instance that kept holding its EIP. The
  start step now requires the registration to stay online across several
  consecutive polls before declaring the runner ready (3 on a warm restart, 2
  on a cold launch); a registration that flaps within that window fails the
  start step — routing into the existing console-output capture and cleanup —
  instead of returning a false success. A flap is logged
  (`wait_for_runner … outcome:flap`) so the failure mode is debuggable. Docs
  now stress scheduling the `cleanup` reaper for warm pools, since it is the
  backstop that reaps a leaked *running* instance whose runner never came up.

## [4.0.1] - 2026-07-08

### Fixed

- **Warm restart corrupted user data** (#66): `ModifyInstanceAttribute` was
  handed an already-base64-encoded string and encoded it a second time, so a
  restarted warm instance booted with unusable user data. The raw bytes are now
  passed through.

## [4.0.0] - 2026-07-02

A capability wave across cost, reliability, reach, and toil. 10 features, each
shipped as its own PR (#50–#59).

### ⚠️ Breaking changes

- **`ec2:CreateTags` is now always required.** Every launched instance (and its
  volumes) is stamped with the action's signature tags — `ec2-github-runner:managed`,
  `:repository`, `:label`, `:started-at` — which the cleanup reaper relies on.
  Grant `ec2:CreateTags` with the condition `ec2:CreateAction = RunInstances`
  (see the README permissions policy) or `RunInstances` will be denied. Previously
  this permission was only needed when using `aws-resource-tags`. (#42, #45)
- **`cleanup-on-start-failure` defaults to `true`.** When a runner fails to
  bootstrap or register, the action now captures the instance's console output and
  **terminates** it, instead of leaving it running after a registration timeout.
  Set `cleanup-on-start-failure: false` to preserve the old keep-it-running
  behavior for interactive debugging. (#41)
- The root EBS volume created for `encrypt-ebs` / `volume-*` now always sets
  `DeleteOnTermination: true`, so resized/encrypted volumes never leak with the
  ephemeral instance. (#44)

### Added

- **Bootstrap diagnostics** (#41): per-phase `ec2-github-runner:bootstrap`
  phone-home tags, fast-fail on `failed:<step>` (naming the step), console-output
  capture on failure (token redacted), and `cleanup-on-start-failure`.
- **Orphan protection** (#42): `max-lifetime-minutes` TTL self-destruct and a new
  `mode: cleanup` reaper (with `max-age-minutes`, `dry-run`) that terminates
  leaked instances this action started in the repo. Example scheduled workflow in
  `docs/cleanup-workflow.yml`.
- **Root volume configuration** (#44): `volume-size`, `volume-type`, `volume-iops`,
  `volume-throughput` — composes with `encrypt-ebs`.
- **Capacity resilience** (#40): `ec2-instance-type` and `subnet-id` accept
  comma-separated ordered fallback lists (subnet/AZ first, then type). New outputs
  `instance-type-used`, `subnet-id-used`.
- **Spot instances** (#39): `market-type: spot` with `spot-fallback` and
  `spot-max-price`; composes with capacity fallback. New output `market-type-used`.
- **Automated runner-version bumps** (#47): `scripts/bump-runner.js` (manual or
  via the weekly `Bump actions/runner` workflow) updates the checksum table,
  defaults, docs, and dist, then opens a no-auto-merge PR.
- **ARM64/Graviton support** (#43): `architecture: arm64`, with AMI-architecture
  validation that fails fast on a mismatch.
- **Multi-runner batches** (#45): `count` (with `allow-partial`) launches N runners
  behind one label for matrix builds. New output `ec2-instance-ids` (JSON array);
  `stop` accepts `ec2-instance-ids`.
- **Pluggable bootstrap** (#46): `pre-runner-script` (inject steps into the built-in
  bootstrap) and `user-data-template` (full override with `{{PLACEHOLDER}}`
  rendering). Community-maintained Ubuntu example in `examples/user-data/`.
- **Warm pools** (#48): `reuse: stop` reuses stopped instances (stop/start) for
  much faster job starts, with `reuse-pool-tag`, `reuse-max-cycles`, and reaper
  draining via `reaper-stopped-max-age`. See the security note — reuse carries disk
  state between jobs and is unsafe for public/untrusted-PR repos.

### IAM

- Base policy additionally needs `ec2:DescribeTags` and `ec2:GetConsoleOutput`
  (diagnostics + reaper). The runner's own instance role (`iam-role-name`) may be
  granted self-scoped `ec2:CreateTags` for the optional bootstrap phone-home.

### Internal

- Unit-test suite grew from 52 to 224 tests; lint, `verify-dist`, and the pinned
  runner checksum verification stay green on every PR.

Earlier releases: https://github.com/namecheap/ec2-github-runner/releases
