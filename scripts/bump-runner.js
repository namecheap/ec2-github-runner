#!/usr/bin/env node
// Codifies the actions/runner version-bump recipe into one command, so the
// bump is a script run (or a merged bot PR) instead of a multi-file manual
// ritual. Updates the checksum table, the action.yml default, the config
// default, the docs, and the tests, then rebuilds dist — encoding the
// "npm ci before npm run package" gotcha in code, not prose.
//
// Usage:
//   node scripts/bump-runner.js <version> [--x64 <sha>] [--arm64 <sha>] [--no-build]
//
// When --x64/--arm64 are omitted, the SHA-256 values are read from the
// official actions/runner release body over the authenticated GitHub API.
//
// parseChecksums / applyBump / readCurrentVersion are exported for tests.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Files whose embedded default-version string is bumped verbatim. The
// checksum table is handled separately (it accumulates entries rather than
// replacing them).
const VERSION_FILES = ['action.yml', 'src/config.js', 'README.md', 'tests/config.test.js'];
const CHECKSUMS_FILE = 'src/runner-checksums.js';

// Parse the linux x64 (and arm64, if present) SHA-256 from an actions/runner
// release body. The hashes are published as HTML-comment-wrapped markers:
//   <!-- BEGIN SHA linux-x64 -->deadbeef...<!-- END SHA linux-x64 -->
// Tolerant of surrounding whitespace; fails loudly on format drift so we
// never write a garbage checksum.
function parseChecksums(releaseBody) {
  const x64 = /BEGIN SHA linux-x64 -->\s*([a-f0-9]{64})/.exec(releaseBody);
  if (!x64) {
    throw new Error('Could not parse the linux-x64 SHA-256 from the release body (format drift?)');
  }
  const arm64 = /BEGIN SHA linux-arm64 -->\s*([a-f0-9]{64})/.exec(releaseBody);
  return { x64: x64[1], arm64: arm64 ? arm64[1] : null };
}

// Read the currently pinned default runner version from action.yml — the
// canonical source (the verify-runner-url CI job reads it the same way).
function readCurrentVersion(rootDir) {
  const content = fs.readFileSync(path.join(rootDir, 'action.yml'), 'utf8');
  const match = /runner-version:[\s\S]*?default:\s*'([^']+)'/.exec(content);
  if (!match) {
    throw new Error('Could not locate the runner-version default in action.yml');
  }
  return match[1];
}

// Apply the bump to the working tree at rootDir. Idempotent: a second run
// with the same version is a no-op. Returns { changed, oldVersion, newVersion }.
function applyBump(rootDir, newVersion, checksums) {
  const oldVersion = readCurrentVersion(rootDir);
  const checksumsPath = path.join(rootDir, CHECKSUMS_FILE);
  let checksumsContent = fs.readFileSync(checksumsPath, 'utf8');
  const alreadyHasEntry = checksumsContent.includes(`'x64-${newVersion}'`);

  if (oldVersion === newVersion && alreadyHasEntry) {
    return { changed: false, oldVersion, newVersion };
  }

  // 1. Checksum table — add the new entries (keep historical ones) and cite
  //    the source. Skip if the entry already exists (idempotency).
  if (!alreadyHasEntry) {
    if (!checksums || !checksums.x64) {
      throw new Error(`No x64 checksum provided for ${newVersion}`);
    }
    const entryLines = [`  'x64-${newVersion}':   '${checksums.x64}',`];
    if (checksums.arm64) {
      entryLines.push(`  'arm64-${newVersion}': '${checksums.arm64}',`);
    }
    checksumsContent = checksumsContent.replace('const CHECKSUMS = {', `const CHECKSUMS = {\n${entryLines.join('\n')}`);
    checksumsContent = checksumsContent.replace('// Sources:\n', `// Sources:\n//   https://github.com/actions/runner/releases/tag/v${newVersion}\n`);
    fs.writeFileSync(checksumsPath, checksumsContent);
  }

  // 2. Bump the embedded default-version string everywhere else.
  if (oldVersion !== newVersion) {
    for (const rel of VERSION_FILES) {
      const filePath = path.join(rootDir, rel);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const before = fs.readFileSync(filePath, 'utf8');
      const after = before.split(oldVersion).join(newVersion);
      if (after !== before) {
        fs.writeFileSync(filePath, after);
      }
    }
  }

  return { changed: true, oldVersion, newVersion };
}

async function fetchReleaseBody(version) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ec2-github-runner-bump' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`https://api.github.com/repos/actions/runner/releases/tags/v${version}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} fetching actions/runner release v${version}`);
  }
  const data = await res.json();
  return data.body || '';
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith('--'));
  if (!version) {
    console.error('usage: node scripts/bump-runner.js <version> [--x64 <sha>] [--arm64 <sha>] [--no-build]');
    process.exit(1);
  }

  let x64 = argValue(args, '--x64');
  let arm64 = argValue(args, '--arm64');
  if (!x64) {
    const body = await fetchReleaseBody(version);
    const parsed = parseChecksums(body);
    x64 = parsed.x64;
    arm64 = parsed.arm64;
  }

  const root = path.resolve(__dirname, '..');
  const result = applyBump(root, version, { x64, arm64 });
  if (!result.changed) {
    console.log(`Already pinned to actions/runner v${version}; nothing to do.`);
    return;
  }

  // Encode the recipe's gotcha: npm ci BEFORE npm run package, or verify-dist
  // churns on a dirty node_modules.
  if (!args.includes('--no-build')) {
    execSync('npm ci', { cwd: root, stdio: 'inherit' });
    execSync('npm run package', { cwd: root, stdio: 'inherit' });
  }
  console.log(`Bumped actions/runner ${result.oldVersion} -> ${result.newVersion} and rebuilt dist.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { parseChecksums, readCurrentVersion, applyBump };
