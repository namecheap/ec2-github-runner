// Tests for buildEncryptedRootMapping. The function is a pure transform
// of a DescribeImages response — no AWS/GitHub stubbing required.
//
// aws.js and config.js are required at module load time, so mocks must be
// in place before any require() runs. jest.mock() is hoisted by Jest's
// transform and executes before module-level require() calls.
jest.mock('../src/config', () => ({
  input: { mode: 'start', debug: 'false' },
  githubContext: { owner: 'o', repo: 'r' },
  tagSpecifications: null,
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setFailed: jest.fn(), getInput: jest.fn(),
  startGroup: jest.fn(), endGroup: jest.fn(),
}));

const { buildEncryptedRootMapping } = require('../src/aws');

describe('buildEncryptedRootMapping', () => {
  test('clones the AMI root mapping and flips Encrypted to true', () => {
    const image = {
      RootDeviceName: '/dev/xvda',
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/xvda',
          Ebs: {
            SnapshotId: 'snap-abc',
            VolumeSize: 30,
            VolumeType: 'gp3',
            Iops: 3000,
            DeleteOnTermination: true,
          },
        },
        { DeviceName: '/dev/sdb', VirtualName: 'ephemeral0' }, // non-EBS, should be ignored
      ],
    };

    const result = buildEncryptedRootMapping(image);

    expect(result).toEqual([{
      DeviceName: '/dev/xvda',
      Ebs: {
        VolumeSize: 30,
        VolumeType: 'gp3',
        Iops: 3000,
        DeleteOnTermination: true,
        Encrypted: true,
      },
    }]);
    // SnapshotId must be dropped (AWS uses the AMI's snapshot automatically).
    expect(result[0].Ebs.SnapshotId).toBeUndefined();
  });

  test('preserves volume type + size + IOPS untouched', () => {
    const image = {
      RootDeviceName: '/dev/sda1',
      BlockDeviceMappings: [{
        DeviceName: '/dev/sda1',
        Ebs: { VolumeSize: 100, VolumeType: 'io2', Iops: 10000 },
      }],
    };

    const result = buildEncryptedRootMapping(image);

    expect(result[0].Ebs.VolumeSize).toBe(100);
    expect(result[0].Ebs.VolumeType).toBe('io2');
    expect(result[0].Ebs.Iops).toBe(10000);
    expect(result[0].Ebs.Encrypted).toBe(true);
  });

  test('returns null when the AMI has no root device name', () => {
    expect(buildEncryptedRootMapping({ BlockDeviceMappings: [] })).toBeNull();
  });

  test('returns null when the AMI has no BlockDeviceMappings', () => {
    expect(buildEncryptedRootMapping({ RootDeviceName: '/dev/xvda' })).toBeNull();
  });

  test('returns null when the root mapping has no Ebs sub-object', () => {
    const image = {
      RootDeviceName: '/dev/xvda',
      BlockDeviceMappings: [{ DeviceName: '/dev/xvda', VirtualName: 'ephemeral0' }],
    };
    expect(buildEncryptedRootMapping(image)).toBeNull();
  });

  test('returns null when RootDeviceName points to a mapping that doesn\'t exist', () => {
    const image = {
      RootDeviceName: '/dev/xvda',
      BlockDeviceMappings: [{ DeviceName: '/dev/sdb', Ebs: { VolumeSize: 10 } }],
    };
    expect(buildEncryptedRootMapping(image)).toBeNull();
  });
});
