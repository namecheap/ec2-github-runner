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

  test('parses aws-resource-tags into the awsResourceTags array', () => {
    const tags = [{ Key: 'Owner', Value: 'devops' }];
    const config = loadConfig({ ...startModeInputs, 'aws-resource-tags': JSON.stringify(tags) });
    expect(config.input.awsResourceTags).toEqual(tags);
  });

  test('awsResourceTags is an empty array when aws-resource-tags is empty list', () => {
    const config = loadConfig({ ...startModeInputs, 'aws-resource-tags': '[]' });
    expect(config.input.awsResourceTags).toEqual([]);
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
    expectValidationFailure({ ...startModeInputs, 'mode': 'restart' }, /Wrong mode. Allowed values: start, stop, cleanup/);
  });
});

describe('Config — cleanup mode', () => {
  const cleanupModeInputs = {
    'mode': 'cleanup',
    'github-token': 'ghs_testtoken',
    'aws-resource-tags': '[]',
  };

  test('valid inputs produce a config with defaulted cleanup knobs', () => {
    const config = loadConfig(cleanupModeInputs);
    expect(config.input.mode).toBe('cleanup');
    expect(config.input.maxAgeMinutes).toBe('120');
    expect(config.input.dryRun).toBe('false');
  });

  test('honors max-age-minutes and dry-run overrides', () => {
    const config = loadConfig({ ...cleanupModeInputs, 'max-age-minutes': '30', 'dry-run': 'true' });
    expect(config.input.maxAgeMinutes).toBe('30');
    expect(config.input.dryRun).toBe('true');
  });

  test('still requires github-token', () => {
    expectValidationFailure({ ...cleanupModeInputs, 'github-token': '' }, /'github-token' input is not specified/);
  });
});

describe('Config — root volume inputs', () => {
  test('accepts a valid gp3 sizing combination', () => {
    const config = loadConfig({ ...startModeInputs, 'volume-size': '100', 'volume-type': 'gp3', 'volume-iops': '4000', 'volume-throughput': '250' });
    expect(config.input.volumeSize).toBe('100');
    expect(config.input.volumeType).toBe('gp3');
    expect(config.input.volumeIops).toBe('4000');
    expect(config.input.volumeThroughput).toBe('250');
  });

  test('no volume inputs is valid (AMI defaults)', () => {
    const config = loadConfig(startModeInputs);
    expect(config.input.volumeSize).toBe('');
  });

  test('rejects a non-numeric volume-size', () => {
    expectValidationFailure({ ...startModeInputs, 'volume-size': 'big' }, /'volume-size' must be a positive integer/);
  });

  test('rejects a zero / negative volume-size', () => {
    expectValidationFailure({ ...startModeInputs, 'volume-size': '0' }, /'volume-size' must be a positive integer/);
  });

  test('rejects an unknown volume-type', () => {
    expectValidationFailure({ ...startModeInputs, 'volume-type': 'gp4' }, /'volume-type' must be one of/);
  });

  test('rejects volume-iops with an incompatible type', () => {
    expectValidationFailure({ ...startModeInputs, 'volume-type': 'gp2', 'volume-iops': '4000' }, /'volume-iops' is only valid/);
  });

  test('rejects volume-throughput with a non-gp3 type', () => {
    expectValidationFailure({ ...startModeInputs, 'volume-type': 'io2', 'volume-iops': '4000', 'volume-throughput': '250' }, /'volume-throughput' is only valid with 'volume-type' gp3/);
  });

  test('accepts iops with io2', () => {
    const config = loadConfig({ ...startModeInputs, 'volume-type': 'io2', 'volume-iops': '5000' });
    expect(config.input.volumeIops).toBe('5000');
  });
});

describe('Config — architecture input', () => {
  test('defaults to x64', () => {
    expect(loadConfig(startModeInputs).input.architecture).toBe('x64');
  });

  test('accepts arm64 with a Graviton instance type', () => {
    const config = loadConfig({ ...startModeInputs, 'architecture': 'arm64', 'ec2-instance-type': 'c7g.4xlarge' });
    expect(config.input.architecture).toBe('arm64');
  });

  test('accepts an arm64 fallback list of Graviton types', () => {
    const config = loadConfig({ ...startModeInputs, 'architecture': 'arm64', 'ec2-instance-type': 'c7g.4xlarge,c6g.4xlarge,m7g.4xlarge' });
    expect(config.input.architecture).toBe('arm64');
  });

  test('rejects an invalid architecture', () => {
    expectValidationFailure({ ...startModeInputs, 'architecture': 'x86' }, /'architecture' must be one of/);
  });

  test('rejects a mixed-architecture instance-type list', () => {
    expectValidationFailure({ ...startModeInputs, 'ec2-instance-type': 'c7g.4xlarge,c7i.4xlarge' }, /mixes architectures/);
  });

  test('rejects an instance type whose arch conflicts with the architecture input', () => {
    expectValidationFailure({ ...startModeInputs, 'architecture': 'arm64', 'ec2-instance-type': 'c7i.4xlarge' }, /but 'architecture' is 'arm64'/);
  });
});

describe('Config — spot / market inputs', () => {
  test('defaults to on-demand with default fallback', () => {
    const config = loadConfig(startModeInputs);
    expect(config.input.marketType).toBe('on-demand');
    expect(config.input.spotFallback).toBe('on-demand');
    expect(config.input.spotMaxPrice).toBe('');
  });

  test('accepts a valid spot configuration', () => {
    const config = loadConfig({ ...startModeInputs, 'market-type': 'spot', 'spot-fallback': 'fail', 'spot-max-price': '0.05' });
    expect(config.input.marketType).toBe('spot');
    expect(config.input.spotFallback).toBe('fail');
    expect(config.input.spotMaxPrice).toBe('0.05');
  });

  test('rejects an invalid market-type', () => {
    expectValidationFailure({ ...startModeInputs, 'market-type': 'reserved' }, /'market-type' must be one of/);
  });

  test('rejects an invalid spot-fallback', () => {
    expectValidationFailure({ ...startModeInputs, 'market-type': 'spot', 'spot-fallback': 'retry' }, /'spot-fallback' must be one of/);
  });

  test('rejects a non-numeric spot-max-price', () => {
    expectValidationFailure({ ...startModeInputs, 'market-type': 'spot', 'spot-max-price': 'cheap' }, /'spot-max-price' must be a positive decimal/);
  });

  test('accepts a decimal spot-max-price', () => {
    const config = loadConfig({ ...startModeInputs, 'market-type': 'spot', 'spot-max-price': '1.5' });
    expect(config.input.spotMaxPrice).toBe('1.5');
  });
});

describe('Config — max-lifetime-minutes input', () => {
  test('defaults to 360 when unset', () => {
    const config = loadConfig(startModeInputs);
    expect(config.input.maxLifetimeMinutes).toBe('360');
  });

  test('honors an explicit override, including 0 to disable', () => {
    expect(loadConfig({ ...startModeInputs, 'max-lifetime-minutes': '720' }).input.maxLifetimeMinutes).toBe('720');
    expect(loadConfig({ ...startModeInputs, 'max-lifetime-minutes': '0' }).input.maxLifetimeMinutes).toBe('0');
  });
});

describe('Config — runner-version input', () => {
  test('defaults to 2.335.1 when unset', () => {
    const config = loadConfig(startModeInputs);
    expect(config.input.runnerVersion).toBe('2.335.1');
  });

  test('honors an explicit override', () => {
    const config = loadConfig({ ...startModeInputs, 'runner-version': '2.340.0' });
    expect(config.input.runnerVersion).toBe('2.340.0');
  });
});

describe('Config — encrypt-ebs input', () => {
  test('defaults to "false" when unset', () => {
    const config = loadConfig(startModeInputs);
    expect(config.input.encryptEbs).toBe('false');
  });

  test('honors "true"', () => {
    const config = loadConfig({ ...startModeInputs, 'encrypt-ebs': 'true' });
    expect(config.input.encryptEbs).toBe('true');
  });
});

describe('Config — http-tokens input', () => {
  test('defaults to "required" when unset', () => {
    const config = loadConfig(startModeInputs);
    expect(config.input.httpTokens).toBe('required');
  });

  test('honors an "optional" override', () => {
    const config = loadConfig({ ...startModeInputs, 'http-tokens': 'optional' });
    expect(config.input.httpTokens).toBe('optional');
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
