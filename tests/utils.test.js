const { sortByCreationDate, parseCsv, isArmInstanceType, instanceArch } = require('../src/utils');

describe('isArmInstanceType / instanceArch', () => {
  test('recognizes Graviton families as arm64', () => {
    for (const t of ['c7g.4xlarge', 'm6g.large', 't4g.small', 'c7gd.2xlarge', 'c7gn.xlarge', 'x2gd.medium', 'im4gn.large', 'is4gen.large', 'a1.large', 'hpc7g.16xlarge']) {
      expect(isArmInstanceType(t)).toBe(true);
      expect(instanceArch(t)).toBe('arm64');
    }
  });

  test('treats Intel/AMD families as x64', () => {
    for (const t of ['c7i.4xlarge', 'c6a.large', 'm5.xlarge', 't3.medium', 'c5n.2xlarge', 'r5.large', 'g5.xlarge']) {
      expect(isArmInstanceType(t)).toBe(false);
      expect(instanceArch(t)).toBe('x64');
    }
  });
});

describe('parseCsv', () => {
  test('splits and trims a comma-separated list', () => {
    expect(parseCsv('a, b ,c')).toEqual(['a', 'b', 'c']);
  });

  test('returns a one-element list for a single value (byte-identical path)', () => {
    expect(parseCsv('subnet-a')).toEqual(['subnet-a']);
  });

  test('drops empty entries from trailing/double commas', () => {
    expect(parseCsv('a,,b,')).toEqual(['a', 'b']);
  });

  test('returns an empty array for empty / undefined input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv(undefined)).toEqual([]);
  });
});

describe('sortByCreationDate', () => {
  test('sorts images by CreationDate descending (newest first)', () => {
    const data = {
      Images: [
        { ImageId: 'ami-old', CreationDate: '2024-01-01T00:00:00.000Z' },
        { ImageId: 'ami-new', CreationDate: '2026-04-20T00:00:00.000Z' },
        { ImageId: 'ami-mid', CreationDate: '2025-06-15T00:00:00.000Z' },
      ],
    };

    sortByCreationDate(data);

    expect(data.Images.map(i => i.ImageId)).toEqual(['ami-new', 'ami-mid', 'ami-old']);
  });

  test('mutates the input array in place', () => {
    const data = { Images: [
      { CreationDate: '2020-01-01T00:00:00.000Z' },
      { CreationDate: '2023-01-01T00:00:00.000Z' },
    ] };
    const originalRef = data.Images;

    sortByCreationDate(data);

    expect(data.Images).toBe(originalRef);
  });

  test('handles a single-image list without error', () => {
    const data = { Images: [{ CreationDate: '2025-01-01T00:00:00.000Z' }] };
    expect(() => sortByCreationDate(data)).not.toThrow();
    expect(data.Images).toHaveLength(1);
  });

  test('handles an empty Images array', () => {
    const data = { Images: [] };
    expect(() => sortByCreationDate(data)).not.toThrow();
    expect(data.Images).toEqual([]);
  });

  test('treats equal CreationDate entries as stable-equal', () => {
    const date = '2025-01-01T00:00:00.000Z';
    const data = { Images: [
      { ImageId: 'a', CreationDate: date },
      { ImageId: 'b', CreationDate: date },
    ] };

    sortByCreationDate(data);

    expect(data.Images.map(i => i.ImageId).sort()).toEqual(['a', 'b']);
  });
});
