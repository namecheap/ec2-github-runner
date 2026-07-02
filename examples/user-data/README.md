# Custom user-data templates

> **Support boundary.** The built-in **yum-based** bootstrap (Amazon Linux 2023) is the only *supported* path. Templates in this directory are **community-maintained starting points**. When you supply `user-data-template`, the action renders your placeholders and gives you the same diagnostics tooling (bootstrap phone-home tags, console capture, cleanup) — but the script is yours to maintain. Bugs in a custom bootstrap are not action bugs.

## Using a template

```yml
- uses: namecheap/ec2-github-runner@v3
  with:
    mode: start
    github-token: ${{ secrets.GH_PERSONAL_ACCESS_TOKEN }}
    ec2-image-id: ami-ubuntu-...        # an Ubuntu AMI
    ec2-instance-type: c7i.4xlarge
    subnet-id: subnet-123
    security-group-id: sg-123
    user-data-template: ./examples/user-data/ubuntu.sh.tpl
```

`user-data-template` accepts a **repo-relative file path** or an **inline string**.

## Placeholders

The action substitutes these before launch (unknown `{{...}}` tokens fail the run so typos are caught early):

| Placeholder | Value |
| --- | --- |
| `{{RUNNER_VERSION}}` | Pinned `actions/runner` version |
| `{{RUNNER_CHECKSUM_X64}}` | SHA-256 of the linux-x64 tarball |
| `{{RUNNER_CHECKSUM_ARM64}}` | SHA-256 of the linux-arm64 tarball |
| `{{REGISTRATION_TOKEN}}` | Ephemeral runner registration token (secret — never logged) |
| `{{REPO_URL}}` | `https://github.com/<owner>/<repo>` |
| `{{LABEL}}` | The unique runner label |
| `{{TTL_MINUTES}}` | `max-lifetime-minutes` (`0` = disabled) |

**Contract:** the template must register the runner (`config.sh … --ephemeral --unattended` then `run.sh`). Verify the tarball checksum. Everything else is your distro's business. Rendered user-data must stay under the EC2 16 KB limit — fetch large payloads at runtime.

## Templates here

- [`ubuntu.sh.tpl`](ubuntu.sh.tpl) — Ubuntu 24.04 (community-maintained).

For a one-package tweak (e.g. install docker) you usually don't need a full template — use `pre-runner-script` instead, which keeps the supported bootstrap.
