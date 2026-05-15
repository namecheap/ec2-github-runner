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
    expect(checksums.lookup('x64', '2.333.1')).toBe(
      '18f8f68ed1892854ff2ab1bab4fcaa2f5abeedc98093b6cb13638991725cab74',
    );
    expect(checksums.lookup('arm64', '2.333.1')).toBe(
      '69ac7e5692f877189e7dddf4a1bb16cbbd6425568cd69a0359895fac48b9ad3b',
    );
  });

  test('lookup returns null for a missing version', () => {
    expect(checksums.lookup('x64', '9.99.99')).toBeNull();
  });

  test('lookup returns null for an unsupported arch', () => {
    expect(checksums.lookup('riscv', '2.333.1')).toBeNull();
  });
});
