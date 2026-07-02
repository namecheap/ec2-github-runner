# Changelog

All notable changes to this action are documented here. This project follows
[Semantic Versioning](https://semver.org/). The moving major tag (e.g. `v4`)
always points at the latest release in that major line.

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
