// Serialization regression for the warm-pool (reuse: stop) user-data rewrite.
//
// warmStartInstance rewrites a stopped instance's user-data via
// ModifyInstanceAttribute before restarting it. That field is a BLOB
// (BlobAttributeValue.Value: Uint8Array), unlike RunInstances' plain-string
// UserData. The EC2 query protocol base64-encodes a blob's bytes on the wire,
// and EC2 base64-decodes them once before storing what IMDS serves. So the
// value handed to the SDK must be the RAW user-data bytes: a pre-base64'd
// string double-encodes (wire carries base64(base64(userData))), EC2 decodes
// only the outer layer, and IMDS ends up serving the base64 TEXT instead of
// the bootstrap script. The per-boot register step then reads an empty
// GH_REPO_URL and config.sh aborts with "Invalid configuration provided for
// url" — the failure this test guards against.
//
// Unlike warmpool.test.js this file does NOT mock @aws-sdk/client-ec2: it runs
// a real EC2Client through a capturing requestHandler so the assertion pins
// the SDK's actual wire behavior, not a re-implementation of it.
const { EC2Client, ModifyInstanceAttributeCommand } = require('@aws-sdk/client-ec2');

// Serialize a ModifyInstanceAttribute request and return what EC2 would store
// as user-data (i.e. IMDS-served bytes) = the wire UserData.Value blob decoded
// once from base64.
async function imdsWouldServe(value) {
  let body = null;
  const client = new EC2Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' },
    requestHandler: {
      handle(req) {
        body = req.body;
        // Abort before any network I/O; we only need the serialized body.
        return Promise.reject(new Error('__captured__'));
      },
    },
  });
  try {
    await client.send(new ModifyInstanceAttributeCommand({
      InstanceId: 'i-abc', UserData: { Value: value },
    }));
  } catch (err) {
    if (err.message !== '__captured__') throw err;
  }
  const match = /(?:^|&)UserData\.Value=([^&]*)/.exec(body || '');
  if (!match) throw new Error(`UserData.Value not found in serialized body: ${body}`);
  const wire = decodeURIComponent(match[1]);
  return Buffer.from(wire, 'base64').toString('utf8');
}

describe('ModifyInstanceAttribute user-data blob encoding', () => {
  const userData = "#!/bin/bash\nGH_REPO_URL='https://github.com/o/r'\nGH_TOKEN='TOK'\n";

  test('raw user-data bytes (the fix) survive the round-trip verbatim', async () => {
    // This is exactly what warmStartInstance passes: Buffer.from(userData).
    await expect(imdsWouldServe(Buffer.from(userData))).resolves.toBe(userData);
  });

  test("a pre-base64'd string (the bug) double-encodes and loses the script", async () => {
    const served = await imdsWouldServe(Buffer.from(userData).toString('base64'));
    // IMDS would serve base64 text, not the script — no GH_REPO_URL line, so
    // the warm-restart register step reads an empty URL.
    expect(served).not.toBe(userData);
    expect(served).not.toMatch(/^GH_REPO_URL=/m);
    // It's the singly-encoded base64 of the script (the double-encode victim).
    expect(served).toBe(Buffer.from(userData).toString('base64'));
  });
});
