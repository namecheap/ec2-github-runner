// End-to-end tests for the failure-detail capture added to the phone-home
// mechanism (PHONE_HOME_HELPERS / gh_runner_phone_home_failed in src/aws.js).
//
// These tests do not re-implement the generated shell in JS and check
// strings against it — they pull the ACTUAL lines buildUserData() /
// buildReusableUserData() produce, splice in a fabricated failing command in
// place of a real one, and execute the result as a genuine bash script file
// (never a hand-typed command line — this codebase has a documented history
// of subtle shell-quoting bugs, e.g. #63). A fake `curl` supplies IMDS
// identity and a fake `aws` records the create-tags Value it's invoked
// with, so the real gh_runner_phone_home_failed()/gh_runner_phone_home()
// pipeline runs unmodified and we observe exactly what it phones home.
jest.mock('../src/config', () => ({
  input: { mode: 'start', debug: 'false' },
  githubContext: { owner: 'o', repo: 'r' },
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setFailed: jest.fn(), getInput: jest.fn(),
  startGroup: jest.fn(), endGroup: jest.fn(), debug: jest.fn(),
}));

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildUserData } = require('../src/aws');

const args = {
  runnerVersion: '2.335.1', owner: 'o', repo: 'r', label: 'l',
  githubRegistrationToken: 'TOK', shaX64: 'x', shaArm64: 'a',
};

// Fake IMDS (so gh_runner_imds resolves without a real network call) and a
// fake `aws` CLI that records the create-tags Value it receives. Defining
// these as shell FUNCTIONS (not PATH executables) is enough: bash resolves
// a bare command name against functions before PATH.
const HARNESS_PREFIX = [
  'curl() {',
  '  case "$*" in',
  '    *api/token*) echo FAKETOKEN ;;',
  '    *meta-data/instance-id*) echo i-fake123 ;;',
  '    *meta-data/placement/region*) echo us-east-1 ;;',
  '    *) return 1 ;;',
  '  esac',
  '}',
  // Real `mount`/`uname` behave differently (or fail outright) on the
  // non-Linux/non-EC2 machine running this test; stub them so the parts of
  // the script we are NOT testing behave the way they do on a real Amazon
  // Linux instance instead of tripping over host differences.
  'mount() { return 0; }',
  'uname() { echo x86_64; }',
  'aws() {',
  '  for arg in "$@"; do',
  '    case "$arg" in',
  '      Key=*,Value=*) printf \'%s\' "${arg#*,Value=}" > "$AWS_TAG_CAPTURE_FILE" ;;',
  '    esac',
  '  done',
  '  return 0',
  '}',
].join('\n');

function extractBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const bodyStart = start + startMarker.length;
  const end = text.indexOf(endMarker, bodyStart);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return text.slice(bodyStart, end);
}

// Runs a real generated script body (always starting with its own
// `set -euo pipefail`, exactly as buildUserData()/buildReusableUserData()
// emit it) after substituting one real command for a fabricated failing
// one, and returns whatever the fake `aws` captured as the create-tags
// Value — '' if it was never invoked.
function runAndCapturePhoneHome(scriptBody, { marker, fakeCommand, fakeCommandDef, neutralize = [] }) {
  if (!scriptBody.includes(marker)) {
    throw new Error(`replacement marker not found in generated script: ${marker}`);
  }
  let body = scriptBody.replace(marker, fakeCommand);
  // /home/runner only exists on the real instance; give the script a
  // writable stand-in so unrelated lines don't fail before our injected one.
  body = body.replace('cd /home/runner/actions-runner', 'mkdir -p "$PWD/fake-runner-home" && cd "$PWD/fake-runner-home"');
  // No-op out other real commands (e.g. an earlier download/verify step)
  // that are irrelevant to the failure under test but would otherwise run
  // for real (and fail for host/environment reasons unrelated to this test).
  for (const line of neutralize) {
    if (!body.includes(line)) {
      throw new Error(`neutralize target not found in generated script: ${line}`);
    }
    body = body.replace(line, ': # neutralized for test');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec2gh-phonehome-'));
  const captureFile = path.join(dir, 'capture');
  fs.writeFileSync(captureFile, '');
  const scriptPath = path.join(dir, 'script.sh');
  fs.writeFileSync(scriptPath, ['#!/bin/bash', HARNESS_PREFIX, fakeCommandDef || '', body].join('\n'));

  try {
    execFileSync('bash', [scriptPath], {
      env: { ...process.env, AWS_TAG_CAPTURE_FILE: captureFile },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // Expected: the fabricated command fails and the script exits non-zero.
  }
  return fs.readFileSync(captureFile, 'utf8');
}

// A genuinely adversarial failing command: >3KB of output across 60 lines,
// with tabs, NUL-adjacent control bytes, and embedded ANSI color escapes,
// ending in the one line that actually matters. Proves truncation grabs the
// *tail* (where real errors land) and sanitization survives non-ASCII junk.
const LONG_MULTILINE_FAKE_CMD = {
  def: [
    'gh_fake_failing_command() {',
    '  printf \'%s\\n\' "BEGIN-ERROR-MARKER-SHOULD-BE-TRUNCATED-AWAY" >&2',
    '  local i',
    '  for i in $(seq 1 60); do',
    '    printf "garbage line %02d: \\x01\\x02\\tsome\\ttabs\\tand\\x1b[31mANSI\\x1b[0m colors and padding to make this line long enough to matter\\n" "$i" >&2',
    '  done',
    '  printf \'%s\\n\' "REAL_ERROR: config.sh failed: Not configured. Run config.sh to configure a runner." >&2',
    '  return 1',
    '}',
  ].join('\n'),
  call: 'gh_fake_failing_command',
};

describe('phone-home failure-detail capture (real bash execution)', () => {
  test('registerScript (reuse: stop): configuring-step failure surfaces a truncated, sanitized snippet', () => {
    const ud = buildUserData({ ...args, reuse: 'stop' });
    const registerScriptBody = extractBetween(
      ud,
      "cat >/opt/gh-runner-register.sh <<'GH_REGISTER_SCRIPT'\n",
      '\nGH_REGISTER_SCRIPT',
    ).replace(/^#!\/bin\/bash\n/, '');

    const marker = 'sudo -u runner -H env DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 ./config.sh --url "$GH_REPO_URL" --token "$GH_TOKEN" --labels "$GH_LABEL" --ephemeral --unattended --disableupdate';
    const value = runAndCapturePhoneHome(registerScriptBody, {
      marker,
      fakeCommand: LONG_MULTILINE_FAKE_CMD.call,
      fakeCommandDef: LONG_MULTILINE_FAKE_CMD.def,
    });

    expect(value).toMatch(/^failed:configuring:/);
    expect(value).toContain('REAL_ERROR: config.sh failed: Not configured. Run config.sh to configure a runner.');
    // Truncation actually happened: the start of the (much longer) captured
    // output must not have survived into the tag value.
    expect(value).not.toContain('BEGIN-ERROR-MARKER');
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(256);
    expect(value).not.toMatch(/[\n\r]/);
    // eslint-disable-next-line no-control-regex
    expect(value).not.toMatch(/[\x00-\x08\x0e-\x1f]/);
  });

  test('RUNNER_DOWNLOAD heredoc (reuse: stop): downloading-step failure with a pathological huge, newline-filled error stays under 256 chars with no embedded newlines', () => {
    const ud = buildUserData({ ...args, reuse: 'stop' });
    const heredocBody = extractBetween(ud, "sudo -u runner -H bash <<'RUNNER_DOWNLOAD'\n", '\nRUNNER_DOWNLOAD');

    // Pathological: ~50KB of newline-separated garbage with embedded CRs and
    // control bytes, no realistic "error line" at all — worst case for the
    // sanitizer/truncator, not just an adversarial-but-tidy example.
    const hugeFakeCmdDef = [
      'gh_fake_huge_failure() {',
      '  local i',
      '  for i in $(seq 1 2000); do',
      '    printf "junk-%d\\r\\n\\ttabbed\\x07bell\\x08backspace-more-filler-text-here\\n" "$i" >&2',
      '  done',
      '  return 1',
      '}',
    ].join('\n');

    const value = runAndCapturePhoneHome(heredocBody, {
      marker: 'curl -fsSLo "$TARBALL" "$BASE/$TARBALL"',
      fakeCommand: 'gh_fake_huge_failure',
      fakeCommandDef: hugeFakeCmdDef,
    });

    expect(value).toMatch(/^failed:downloading:/);
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(256);
    expect(value).not.toMatch(/[\n\r]/);
  });

  test('plain (reuse: terminate) RUNNER_BOOTSTRAP heredoc: configuring-step failure carries a detail snippet', () => {
    const ud = buildUserData({ ...args, reuse: 'terminate' });
    const heredocBody = extractBetween(ud, "sudo -u runner -H bash <<'RUNNER_BOOTSTRAP'\n", '\nRUNNER_BOOTSTRAP');

    const marker = './config.sh --url "https://github.com/o/r" --token "TOK" --labels "l" --ephemeral --unattended --disableupdate';
    const value = runAndCapturePhoneHome(heredocBody, {
      marker,
      fakeCommand: LONG_MULTILINE_FAKE_CMD.call,
      fakeCommandDef: LONG_MULTILINE_FAKE_CMD.def,
      // The download/verify/extract steps run for real before config.sh in
      // this heredoc; neutralize them so this test isolates the configuring
      // step (they have their own dedicated coverage in the download test).
      neutralize: [
        'curl -fsSLo "$TARBALL" "$BASE/$TARBALL"',
        'echo "$EXPECTED_SHA  $TARBALL" | sha256sum -c -',
        'tar xzf "$TARBALL"',
      ],
    });

    expect(value).toMatch(/^failed:configuring:/);
    expect(value).toContain('REAL_ERROR: config.sh failed');
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(256);
    expect(value).not.toMatch(/[\n\r]/);
  });

  test('plain (reuse: terminate) outer root shell: installing-step failure with NO stderr output stays backward compatible ("failed:<step>" only)', () => {
    const ud = buildUserData({ ...args, reuse: 'terminate' });
    const outerBody = ud.slice(0, ud.indexOf("sudo -u runner -H bash <<'RUNNER_BOOTSTRAP'"));

    const value = runAndCapturePhoneHome(outerBody, {
      marker: 'yum install -y libicu make sudo',
      fakeCommand: 'gh_fake_silent_failure',
      fakeCommandDef: 'gh_fake_silent_failure() { return 1; }',
    });

    // No detail was ever written to stderr, so no scratch file content — the
    // value must be exactly the old, no-detail shape (no trailing ':').
    expect(value).toBe('failed:installing');
  });

  test('reuse: stop outer root shell (one-time install): installing-step failure carries a detail snippet', () => {
    const ud = buildUserData({ ...args, reuse: 'stop' });
    const outerBody = ud.slice(0, ud.indexOf("sudo -u runner -H bash <<'RUNNER_DOWNLOAD'"));

    const value = runAndCapturePhoneHome(outerBody, {
      marker: 'yum install -y libicu make sudo',
      fakeCommand: 'gh_fake_yum_failure',
      fakeCommandDef: [
        'gh_fake_yum_failure() {',
        '  printf \'%s\\n\' "Error: Unable to find a match: libicu" >&2',
        '  return 1',
        '}',
      ].join('\n'),
    });

    expect(value).toBe('failed:installing:Error: Unable to find a match: libicu');
  });
});
