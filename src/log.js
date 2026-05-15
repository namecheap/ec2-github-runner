const core = require('@actions/core');

// Structured logger. Every notable lifecycle event emits a JSON-shaped
// line via core.info so the Actions run summary can be scraped or
// eyeballed without parsing free-form text. When config.input.debug is
// true the debug() helper also emits, which gives consumers a way to
// get verbose diagnostics without changing default output.
//
// Gotchas:
//   - We defer `require('./config')` until first use because log.js is
//     loaded transitively from src/index.js before config validation
//     completes; importing at top-level would short-circuit on any
//     config error.
//   - sanitize() redacts values under known secret keys. Always pass
//     raw fields through sanitize() before logging an object that may
//     contain user input (tokens, credentials, etc.).

const SECRET_KEYS = new Set([
  'githubToken',
  'github-token',
  'token',
  'aws-access-key-id',
  'aws-secret-access-key',
  'GPG_PRIVATE_KEY',
  'password',
]);

function sanitize(fields) {
  if (!fields || typeof fields !== 'object') return fields;
  const out = Array.isArray(fields) ? [] : {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = '***';
    } else if (v && typeof v === 'object') {
      out[k] = sanitize(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level, step, fields) {
  const payload = {
    step,
    mode: (() => {
      // best-effort mode lookup; log.js may be required before Config
      // finishes its constructor, in which case config.input is undefined.
      try {
        const config = require('./config');
        return config && config.input ? config.input.mode : undefined;
      } catch (_e) {
        return undefined;
      }
    })(),
    ...(fields ? sanitize(fields) : {}),
  };
  const line = JSON.stringify(payload);
  switch (level) {
    case 'warning':
      core.warning(line);
      break;
    case 'error':
      core.error(line);
      break;
    default:
      core.info(line);
  }
}

function info(step, fields) { emit('info', step, fields); }
function warn(step, fields) { emit('warning', step, fields); }
function err(step, fields) { emit('error', step, fields); }

function debug(step, fields) {
  try {
    const config = require('./config');
    if (config && config.input && config.input.debug === 'true') {
      emit('info', step, { debug: true, ...fields });
    }
  } catch (_e) {
    // Config not yet loaded — skip debug output.
  }
}

module.exports = {
  info,
  warn,
  error: err,
  debug,
  sanitize,
};
