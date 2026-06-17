const checksums = require('../src/runner-checksums');

describe('runner-checksums', () => {
  test('exports an arch-version keyed map', () => {
    expect(typeof checksums.CHECKSUMS).toBe('object');
    expect(Object.keys(checksums.CHECKSUMS).length).toBeGreaterThan(0);
  });

  test('all entries are 64-char lowercase hex', () => {
    for (const [key, value] of Object.entries(checksums.CHECKSUMS)) {
      expect(key).toMatch(/^(x64|arm64)-\d+\.\d+\.\d+$/);
      expect(value).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test('covers both x64 and arm64 for every version present', () => {
    const versions = new Set(Object.keys(checksums.CHECKSUMS).map((k) => k.split('-')[1]));
    for (const v of versions) {
      expect(checksums.CHECKSUMS[`x64-${v}`]).toBeDefined();
      expect(checksums.CHECKSUMS[`arm64-${v}`]).toBeDefined();
    }
  });

  test('lookup returns the expected value for a known key', () => {
    expect(checksums.lookup('x64', '2.335.1')).toBe(
      '4ef2f25285f0ae4477f1fe1e346db76d2f3ebf03824e2ddd1973a2819bf6c8cf',
    );
    expect(checksums.lookup('arm64', '2.335.1')).toBe(
      '6d1e85bfd1a506a8b17c1f1b9b57dba458ffed90898799aaa9f599520b0d9207',
    );
  });

  test('lookup returns null for a missing version', () => {
    expect(checksums.lookup('x64', '9.99.99')).toBeNull();
  });

  test('lookup returns null for an unsupported arch', () => {
    expect(checksums.lookup('riscv', '2.335.1')).toBeNull();
  });
});
