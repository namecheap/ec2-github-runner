// config.js evaluates at module load time:
//   module.exports = new Config();
// inside a try/catch that routes failures to core.setFailed() rather than
// rethrowing. Every test case mocks @actions/core + @actions/github,
// resets the module cache, re-requires the module, and inspects either
// the Config singleton (success case) or the core.setFailed mock (failure
// case) to verify validation behavior.

const startModeInputs = {
  'mode': 'start',
  'github-token': 'ghs_testtoken',
  'ec2-image-owner': '699717368611',
  'ec2-image-filters': JSON.stringify([{ Name: 'name', Values: ['nc-al2023-*'] }]),
  'ec2-instance-type': 't3.medium',
  'subnet-id': 'subnet-aaa',
  'security-group-id': 'sg-bbb',
  'aws-resource-tags': '[]',
};

const stopModeInputs = {
  'mode': 'stop',
  'github-token': 'ghs_testtoken',
  'label': 'runner-xyz',
  'ec2-instance-id': 'i-abc',
  'aws-resource-tags': '[]',
};

let coreMock;

function loadConfig(inputs) {
  jest.resetModules();
  coreMock = {
    getInput: jest.fn((name) => inputs[name] ?? ''),
    error: jest.fn(),
    setFailed: jest.fn(),
    info: jest.fn(),
  };
  jest.doMock('@actions/core', () => coreMock);
  jest.doMock('@actions/github', () => ({
    context: { repo: { owner: 'namecheap', repo: 'ec2-github-runner' } },
  }));
  return require('../src/config');
}

function expectValidationFailure(inputs, pattern) {
  const result = loadConfig(inputs);
  expect(result).toEqual({});  // the try/catch leaves module.exports empty
  expect(coreMock.setFailed).toHaveBeenCalledTimes(1);
  expect(coreMock.setFailed.mock.calls[0][0]).toMatch(pattern);
}

describe('Config — start mode', () => {
  test('valid inputs produce a fully-populated config', () => {
    const config = loadConfig(startModeInputs);

    expect(config.input.mode).toBe('start');
    expect(config.input.githubToken).toBe('ghs_testtoken');
    expect(config.input.ec2InstanceType).toBe('t3.medium');
    expect(config.input.ec2ImageFilters).toEqual([{ Name: 'name', Values: ['nc-al2023-*'] }]);
    expect(config.githubContext).toEqual({ owner: 'namecheap', repo: 'ec2-github-runner' });
  });

  test('builds tagSpecifications for instance and volume when tags provided', () => {
    const tags = [{ Key: 'Owner', Value: 'devops' }];
    const config = loadConfig({ ...startModeInputs, 'aws-resource-tags': JSON.stringify(tags) });

    expect(config.tagSpecifications).toHaveLength(2);
    expect(config.tagSpecifications[0].ResourceType).toBe('instance');
    expect(config.tagSpecifications[1].ResourceType).toBe('volume');
    expect(config.tagSpecifications[0].Tags).toEqual(tags);
  });

  test('tagSpecifications is null when aws-resource-tags is empty list', () => {
    const config = loadConfig({ ...startModeInputs, 'aws-resource-tags': '[]' });
    expect(config.tagSpecifications).toBeNull();
  });

  test('reports missing mode via core.setFailed', () => {
    expectValidationFailure({ ...startModeInputs, 'mode': '' }, /'mode' input is not specified/);
  });

  test('reports missing github-token via core.setFailed', () => {
    expectValidationFailure({ ...startModeInputs, 'github-token': '' }, /'github-token' input is not specified/);
  });

  test('reports missing ec2-instance-type via core.setFailed', () => {
    expectValidationFailure({ ...startModeInputs, 'ec2-instance-type': '' }, /required inputs are provided for the 'start' mode/);
  });

  test('reports missing subnet-id via core.setFailed', () => {
    expectValidationFailure({ ...startModeInputs, 'subnet-id': '' }, /required inputs are provided for the 'start' mode/);
  });

  test('reports missing security-group-id via core.setFailed', () => {
    expectValidationFailure({ ...startModeInputs, 'security-group-id': '' }, /required inputs are provided for the 'start' mode/);
  });

  test('reports missing AMI search inputs via core.setFailed', () => {
    expectValidationFailure({ ...startModeInputs, 'ec2-image-filters': '', 'ec2-image-id': '' }, /required inputs for AMI search/);
  });

  test('accepts ec2-image-id alone when ec2-image-filters is absent', () => {
    const inputs = { ...startModeInputs, 'ec2-image-filters': '', 'ec2-image-id': 'ami-0abc' };
    const config = loadConfig(inputs);
    expect(config.input.ec2ImageId).toBe('ami-0abc');
    expect(config.input.ec2ImageFilters).toBeNull();
  });
});

describe('Config — stop mode', () => {
  test('valid inputs produce a fully-populated config', () => {
    const config = loadConfig(stopModeInputs);

    expect(config.input.mode).toBe('stop');
    expect(config.input.label).toBe('runner-xyz');
    expect(config.input.ec2InstanceId).toBe('i-abc');
  });

  test('reports missing label via core.setFailed', () => {
    expectValidationFailure({ ...stopModeInputs, 'label': '' }, /required inputs are provided for the 'stop' mode/);
  });

  test('reports missing ec2-instance-id via core.setFailed', () => {
    expectValidationFailure({ ...stopModeInputs, 'ec2-instance-id': '' }, /required inputs are provided for the 'stop' mode/);
  });
});

describe('Config — mode validation', () => {
  test('reports unknown mode via core.setFailed', () => {
    expectValidationFailure({ ...startModeInputs, 'mode': 'restart' }, /Wrong mode. Allowed values: start, stop/);
  });
});

describe('Config — debug input', () => {
  test('defaults to "false" when unset', () => {
    const config = loadConfig(startModeInputs);
    expect(config.input.debug).toBe('false');
  });

  test('honors "true"', () => {
    const config = loadConfig({ ...startModeInputs, 'debug': 'true' });
    expect(config.input.debug).toBe('true');
  });
});

describe('Config — generateUniqueLabel', () => {
  test('returns a 5-character alphanumeric string', () => {
    const config = loadConfig(startModeInputs);
    const label = config.generateUniqueLabel();
    expect(label).toMatch(/^[a-z0-9]{5}$/);
  });

  test('two successive calls almost always return different labels', () => {
    const config = loadConfig(startModeInputs);
    const a = config.generateUniqueLabel();
    const b = config.generateUniqueLabel();
    // 36^5 = 60M collisions possible; effectively never equal.
    expect(a).not.toBe(b);
  });
});
