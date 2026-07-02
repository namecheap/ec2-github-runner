// Tests for the root-device mapping builder and its helpers. Pure
// transforms of a DescribeImages response — no AWS/GitHub stubbing needed.
// jest.mock is hoisted and runs before the module-level require()s.
jest.mock('../src/config', () => ({
  input: { mode: 'start', debug: 'false' },
  githubContext: { owner: 'o', repo: 'r' },
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setFailed: jest.fn(), getInput: jest.fn(),
  startGroup: jest.fn(), endGroup: jest.fn(),
}));

const { buildRootDeviceMapping, wantsRootDeviceMapping, buildVolumeOpts } = require('../src/aws');

const imageWith = (ebs, rootDev = '/dev/xvda') => ({
  RootDeviceName: rootDev,
  BlockDeviceMappings: [
    { DeviceName: rootDev, Ebs: ebs },
    { DeviceName: '/dev/sdb', VirtualName: 'ephemeral0' },
  ],
});

describe('buildRootDeviceMapping — encryption', () => {
  test('clones the AMI root mapping and flips Encrypted to true', () => {
    const image = imageWith({ SnapshotId: 'snap-abc', VolumeSize: 30, VolumeType: 'gp3', Iops: 3000, DeleteOnTermination: true });
    const result = buildRootDeviceMapping(image, { encrypt: true });
    expect(result).toEqual([{
      DeviceName: '/dev/xvda',
      Ebs: { VolumeSize: 30, VolumeType: 'gp3', Iops: 3000, DeleteOnTermination: true, Encrypted: true },
    }]);
    expect(result[0].Ebs.SnapshotId).toBeUndefined();
  });

  test('does not set Encrypted when encrypt is false', () => {
    const result = buildRootDeviceMapping(imageWith({ VolumeSize: 30 }), { volumeSize: 50 });
    expect(result[0].Ebs.Encrypted).toBeUndefined();
  });
});

describe('buildRootDeviceMapping — sizing', () => {
  test('applies size / type / iops / throughput overrides', () => {
    const image = imageWith({ VolumeSize: 8, VolumeType: 'gp3' });
    const result = buildRootDeviceMapping(image, { volumeSize: 100, volumeType: 'gp3', volumeIops: 4000, volumeThroughput: 250 });
    expect(result[0].Ebs).toMatchObject({ VolumeSize: 100, VolumeType: 'gp3', Iops: 4000, Throughput: 250 });
  });

  test('leaves omitted fields at the AMI default', () => {
    const image = imageWith({ VolumeSize: 30, VolumeType: 'gp2' });
    const result = buildRootDeviceMapping(image, { volumeSize: 60 });
    expect(result[0].Ebs.VolumeSize).toBe(60);
    expect(result[0].Ebs.VolumeType).toBe('gp2'); // untouched
  });

  test('composes encryption AND sizing in a single mapping', () => {
    const image = imageWith({ VolumeSize: 8, VolumeType: 'gp3' });
    const result = buildRootDeviceMapping(image, { encrypt: true, volumeSize: 120, volumeType: 'gp3', volumeThroughput: 300 });
    expect(result).toHaveLength(1);
    expect(result[0].Ebs).toMatchObject({ Encrypted: true, VolumeSize: 120, VolumeType: 'gp3', Throughput: 300, DeleteOnTermination: true });
  });

  test('rejects a size smaller than the AMI snapshot, naming both numbers', () => {
    const image = imageWith({ VolumeSize: 30 });
    expect(() => buildRootDeviceMapping(image, { volumeSize: 20 })).toThrow(/20 GiB.*30 GiB/);
  });

  test('allows a size equal to the AMI snapshot', () => {
    const image = imageWith({ VolumeSize: 30 });
    expect(buildRootDeviceMapping(image, { volumeSize: 30 })[0].Ebs.VolumeSize).toBe(30);
  });
});

describe('buildRootDeviceMapping — DeleteOnTermination', () => {
  test('is always forced true, even when the AMI omits it', () => {
    expect(buildRootDeviceMapping(imageWith({ VolumeSize: 8 }), { encrypt: true })[0].Ebs.DeleteOnTermination).toBe(true);
    expect(buildRootDeviceMapping(imageWith({ VolumeSize: 8 }), { volumeSize: 50 })[0].Ebs.DeleteOnTermination).toBe(true);
  });

  test('overrides an AMI mapping that set DeleteOnTermination false', () => {
    const image = imageWith({ VolumeSize: 8, DeleteOnTermination: false });
    expect(buildRootDeviceMapping(image, { volumeSize: 50 })[0].Ebs.DeleteOnTermination).toBe(true);
  });
});

describe('buildRootDeviceMapping — null cases', () => {
  test('returns null when the AMI has no root device name', () => {
    expect(buildRootDeviceMapping({ BlockDeviceMappings: [] }, { encrypt: true })).toBeNull();
  });
  test('returns null when the AMI has no BlockDeviceMappings', () => {
    expect(buildRootDeviceMapping({ RootDeviceName: '/dev/xvda' }, { encrypt: true })).toBeNull();
  });
  test('returns null when the root mapping has no Ebs sub-object', () => {
    const image = { RootDeviceName: '/dev/xvda', BlockDeviceMappings: [{ DeviceName: '/dev/xvda', VirtualName: 'ephemeral0' }] };
    expect(buildRootDeviceMapping(image, { encrypt: true })).toBeNull();
  });
  test('returns null when RootDeviceName points to a missing mapping', () => {
    const image = { RootDeviceName: '/dev/xvda', BlockDeviceMappings: [{ DeviceName: '/dev/sdb', Ebs: { VolumeSize: 10 } }] };
    expect(buildRootDeviceMapping(image, { encrypt: true })).toBeNull();
  });
});

describe('wantsRootDeviceMapping — zero-diff regression', () => {
  test('false when no encryption and no volume inputs (AMI default preserved)', () => {
    expect(wantsRootDeviceMapping({ encryptEbs: 'false', volumeSize: '', volumeType: '', volumeIops: '', volumeThroughput: '' })).toBe(false);
  });
  test('true when encryption is on', () => {
    expect(wantsRootDeviceMapping({ encryptEbs: 'true' })).toBe(true);
  });
  test('true when any single volume input is set', () => {
    expect(wantsRootDeviceMapping({ encryptEbs: 'false', volumeSize: '100' })).toBe(true);
    expect(wantsRootDeviceMapping({ encryptEbs: 'false', volumeType: 'gp3' })).toBe(true);
    expect(wantsRootDeviceMapping({ encryptEbs: 'false', volumeIops: '4000' })).toBe(true);
    expect(wantsRootDeviceMapping({ encryptEbs: 'false', volumeThroughput: '250' })).toBe(true);
  });
});

describe('buildVolumeOpts', () => {
  test('parses numeric inputs and leaves omitted ones undefined', () => {
    const opts = buildVolumeOpts({ encryptEbs: 'true', volumeSize: '100', volumeType: 'gp3', volumeIops: '4000', volumeThroughput: '250' });
    expect(opts).toEqual({ encrypt: true, volumeSize: 100, volumeType: 'gp3', volumeIops: 4000, volumeThroughput: 250 });
  });
  test('undefined for unset numeric fields, encrypt false when not "true"', () => {
    const opts = buildVolumeOpts({ encryptEbs: 'false', volumeSize: '', volumeType: '', volumeIops: '', volumeThroughput: '' });
    expect(opts).toEqual({ encrypt: false, volumeSize: undefined, volumeType: undefined, volumeIops: undefined, volumeThroughput: undefined });
  });
});
