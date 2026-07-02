#!/bin/bash
# Community-maintained user-data-template for Ubuntu (24.04 tested).
#
# UNSUPPORTED: the built-in yum bootstrap is the only supported path. This
# template is a starting point so Ubuntu users copy one file instead of
# forking. The action substitutes the {{PLACEHOLDERS}} before launch; keep
# them intact. Pass it via:  user-data-template: ./examples/user-data/ubuntu.sh.tpl
set -euo pipefail

# TTL self-destruct (max-lifetime-minutes). Requires the action's
# InstanceInitiatedShutdownBehavior=terminate, which it sets when TTL > 0.
if [ "{{TTL_MINUTES}}" != "0" ]; then
  shutdown -h +{{TTL_MINUTES}} || true
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl tar libicu-dev sudo

# Non-root runner user (idempotent).
if ! id runner >/dev/null 2>&1; then
  useradd -m -s /bin/bash runner
fi

sudo -u runner -H bash <<'RUNNER_BOOTSTRAP'
set -euo pipefail
cd "$HOME"
mkdir -p actions-runner && cd actions-runner

case "$(uname -m)" in
  aarch64) RUNNER_ARCH="arm64"; EXPECTED_SHA="{{RUNNER_CHECKSUM_ARM64}}" ;;
  amd64|x86_64) RUNNER_ARCH="x64"; EXPECTED_SHA="{{RUNNER_CHECKSUM_X64}}" ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

RUNNER_VERSION="{{RUNNER_VERSION}}"
TARBALL="actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
curl -fsSLo "$TARBALL" "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"
echo "$EXPECTED_SHA  $TARBALL" | sha256sum -c -
tar xzf "$TARBALL"

export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
./config.sh --url "{{REPO_URL}}" --token "{{REGISTRATION_TOKEN}}" --labels "{{LABEL}}" --ephemeral --unattended --disableupdate
./run.sh
RUNNER_BOOTSTRAP
