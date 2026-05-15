# ec2-github-runner — Claude conventions

## Commit style

- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, etc. Lowercase summary, no trailing period.
- **Do not append `Co-Authored-By: Claude …` trailers.** Commits authored by the user via Claude should look like the user's own commits.
- Bundle related changes into one commit; split unrelated changes into separate commits.

## Supported OS scope

This action targets **yum-based Linux only** (Amazon Linux 2023 tested baseline; AL2 / RHEL family in principle). The bootstrap in `src/aws.js` hardcodes `yum`, `useradd`, `sudo`, `bash`, and a tmpfs `/tmp` (`mount -o remount,size=1G /tmp`). Debian, Ubuntu, Alpine, and other non-yum distros are explicitly out of scope.

When reviewing or editing `userData` in `src/aws.js`:

- Do not propose apt/apk fallbacks, package-manager detection, or other cross-distro portability shims.
- Do not flag hardcoded `yum install` lines as a portability concern — that's the documented contract.
- See the `> [!IMPORTANT]` callout at the top of `README.md` for the user-facing version of this policy.

## Build artifact

`dist/index.js` is a committed `@vercel/ncc` bundle of `src/index.js`. Whenever you change anything under `src/` or modify `package.json` dependencies, rebuild before committing:

```
npm run package
```

CI's `verify-dist` job will fail the PR if `dist/` drifts from a clean build.

## Tests

`npm test` runs Jest against everything under `tests/`. All 52 existing tests must keep passing. New behavior in `src/` should land with a matching test in `tests/`.

## Dependencies

The project deliberately runs lean — `lodash` was removed in favor of native JS. Before adding a new runtime dependency, check whether 5–10 lines of native code would do; the bundle ships in `dist/` on every action invocation, so weight matters.
