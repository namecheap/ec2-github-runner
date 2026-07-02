// Tests for scripts/bump-runner.js — parseChecksums against a real-format
// release-body fixture, and applyBump against a copy of the actual repo
// files in a temp tree (so the test tracks the real file formats), including
// an idempotency check.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseChecksums, applyBump, readCurrentVersion } = require('../scripts/bump-runner');

const REPO_ROOT = path.resolve(__dirname, '..');
const COPIED_FILES = ['action.yml', 'src/config.js', 'src/runner-checksums.js', 'README.md', 'tests/config.test.js'];

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-runner-'));
  for (const rel of COPIED_FILES) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
  }
  return dir;
}

const readAll = (dir) => Object.fromEntries(COPIED_FILES.map((rel) => [rel, fs.readFileSync(path.join(dir, rel), 'utf8')]));

describe('parseChecksums', () => {
  const body = fs.readFileSync(path.join(__dirname, 'fixtures', 'runner-release-body.txt'), 'utf8');

  test('extracts the linux x64 and arm64 SHA-256 from the release body', () => {
    expect(parseChecksums(body)).toEqual({
      x64: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      arm64: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
  });

  test('tolerates whitespace after the marker', () => {
    const spaced = body.replace('linux-x64 -->a', 'linux-x64 -->\n  a');
    expect(parseChecksums(spaced).x64).toMatch(/^a{64}$/);
  });

  test('returns null arm64 when the release has no arm64 marker (single-arch)', () => {
    const noArm = body.replace(/- Actions Runner \(Linux ARM64\).*\n/, '');
    expect(parseChecksums(noArm).arm64).toBeNull();
  });

  test('throws loudly on format drift instead of writing garbage', () => {
    expect(() => parseChecksums('no checksums here')).toThrow(/format drift/);
  });
});

describe('applyBump', () => {
  const NEW = '9.9.9';
  const X64 = 'c'.repeat(64);
  const ARM64 = 'd'.repeat(64);

  test('updates every recipe file and adds the checksum entries', () => {
    const dir = makeTempRepo();
    const oldVersion = readCurrentVersion(dir);
    const result = applyBump(dir, NEW, { x64: X64, arm64: ARM64 });

    expect(result).toMatchObject({ changed: true, oldVersion, newVersion: NEW });

    const files = readAll(dir);
    // Checksum table gained both arch entries (historical entry preserved).
    expect(files['src/runner-checksums.js']).toContain(`'x64-${NEW}':`);
    expect(files['src/runner-checksums.js']).toContain(X64);
    expect(files['src/runner-checksums.js']).toContain(`'arm64-${NEW}':`);
    expect(files['src/runner-checksums.js']).toContain(`'x64-${oldVersion}':`); // not removed
    // Default version bumped in action.yml + config + docs + tests.
    expect(files['action.yml']).toContain(`default: '${NEW}'`);
    expect(files['src/config.js']).toContain(`|| '${NEW}'`);
    expect(files['tests/config.test.js']).toContain(NEW);
    expect(files['action.yml']).not.toContain(`default: '${oldVersion}'`);
  });

  test('is idempotent — a second run makes no further changes', () => {
    const dir = makeTempRepo();
    applyBump(dir, NEW, { x64: X64, arm64: ARM64 });
    const afterFirst = readAll(dir);

    const second = applyBump(dir, NEW, { x64: X64, arm64: ARM64 });
    expect(second.changed).toBe(false);
    expect(readAll(dir)).toEqual(afterFirst);
  });

  test('omits the arm64 entry when no arm64 checksum is supplied', () => {
    const dir = makeTempRepo();
    applyBump(dir, NEW, { x64: X64, arm64: null });
    const checksums = fs.readFileSync(path.join(dir, 'src/runner-checksums.js'), 'utf8');
    expect(checksums).toContain(`'x64-${NEW}':`);
    expect(checksums).not.toContain(`'arm64-${NEW}':`);
  });
});
