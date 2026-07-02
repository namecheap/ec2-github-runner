// User-data template rendering for the `user-data-template` input (full
// bootstrap override). The action renders a fixed set of placeholders and
// submits the result verbatim; the script itself is the user's business.
// Pure functions — no I/O — so rendering and validation are unit-testable.

// EC2 caps user-data at 16 KB (raw, before base64). Guard against it up
// front with a clear error rather than a cryptic RunInstances rejection.
const MAX_USER_DATA_BYTES = 16 * 1024;

// The documented placeholders a template may reference.
const PLACEHOLDERS = [
  'RUNNER_VERSION',
  'RUNNER_CHECKSUM_X64',
  'RUNNER_CHECKSUM_ARM64',
  'REGISTRATION_TOKEN',
  'REPO_URL',
  'LABEL',
  'TTL_MINUTES',
];

// Substitute every documented {{PLACEHOLDER}} with its value, then fail if
// any unknown {{TOKEN}} remains (catches typos before boot). Unused known
// placeholders are fine.
function renderUserDataTemplate(template, vars) {
  let out = template;
  for (const key of PLACEHOLDERS) {
    const value = vars[key] != null ? String(vars[key]) : '';
    out = out.split(`{{${key}}}`).join(value);
  }
  const unknown = [...out.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  if (unknown.length > 0) {
    const uniq = [...new Set(unknown)];
    throw new Error(
      `Unknown placeholder(s) in user-data-template: ${uniq.join(', ')}. ` +
      `Supported placeholders: ${PLACEHOLDERS.join(', ')}`,
    );
  }
  return out;
}

// Throw if the rendered user-data exceeds the EC2 16 KB limit.
function assertUserDataSize(userData) {
  const bytes = Buffer.byteLength(userData, 'utf8');
  if (bytes > MAX_USER_DATA_BYTES) {
    throw new Error(
      `Rendered user-data is ${bytes} bytes, over the EC2 limit of ${MAX_USER_DATA_BYTES} bytes. ` +
      'Trim the pre-runner-script / user-data-template (fetch large payloads at runtime instead).',
    );
  }
  return userData;
}

module.exports = {
  renderUserDataTemplate,
  assertUserDataSize,
  MAX_USER_DATA_BYTES,
  PLACEHOLDERS,
};
