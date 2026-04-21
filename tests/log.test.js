// log.js emits structured JSON via @actions/core.info/warning/error.
// Tests stub the core module and observe what the logger passes through.

const coreMock = {
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
};

beforeEach(() => {
  jest.resetModules();
  coreMock.info.mockReset();
  coreMock.warning.mockReset();
  coreMock.error.mockReset();
  jest.doMock('@actions/core', () => coreMock);
  // config is imported lazily inside log.js; stub it so mode is "start"
  // and debug is false by default.
  jest.doMock('./src/config', () => ({ input: { mode: 'start', debug: 'false' } }), { virtual: true });
});

function loadLog({ debug = 'false', mode = 'start' } = {}) {
  jest.resetModules();
  jest.doMock('@actions/core', () => coreMock);
  jest.doMock('../src/config', () => ({ input: { mode, debug } }), { virtual: false });
  return require('../src/log');
}

describe('log', () => {
  test('info emits JSON with step + mode', () => {
    const log = loadLog();
    log.info('run_instance', { instance_id: 'i-abc' });
    expect(coreMock.info).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(coreMock.info.mock.calls[0][0]);
    expect(payload).toEqual({ step: 'run_instance', mode: 'start', instance_id: 'i-abc' });
  });

  test('warn routes through core.warning', () => {
    const log = loadLog();
    log.warn('associate_address', { error: 'Boom' });
    expect(coreMock.warning).toHaveBeenCalledTimes(1);
    expect(JSON.parse(coreMock.warning.mock.calls[0][0])).toMatchObject({ step: 'associate_address', error: 'Boom' });
  });

  test('error routes through core.error', () => {
    const log = loadLog();
    log.error('terminate_instance', { error: 'Nope' });
    expect(coreMock.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(coreMock.error.mock.calls[0][0])).toMatchObject({ step: 'terminate_instance', error: 'Nope' });
  });

  test('debug emits nothing when config.input.debug is not "true"', () => {
    const log = loadLog({ debug: 'false' });
    log.debug('describe_images_all', { images: [1, 2, 3] });
    expect(coreMock.info).not.toHaveBeenCalled();
  });

  test('debug emits JSON when config.input.debug is "true"', () => {
    const log = loadLog({ debug: 'true' });
    log.debug('describe_images_all', { images: [{ id: 'ami-1' }] });
    expect(coreMock.info).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(coreMock.info.mock.calls[0][0]);
    expect(payload).toMatchObject({ step: 'describe_images_all', debug: true });
    expect(payload.images).toEqual([{ id: 'ami-1' }]);
  });

  test('sanitize redacts known secret keys', () => {
    const log = loadLog();
    const out = log.sanitize({
      githubToken: 'ghs_abc',
      label: 'runner-xyz',
      nested: { 'github-token': 'ghs_inner', password: 'p', other: 'ok' },
    });
    expect(out).toEqual({
      githubToken: '***',
      label: 'runner-xyz',
      nested: { 'github-token': '***', password: '***', other: 'ok' },
    });
  });

  test('info with a payload containing secret keys redacts them', () => {
    const log = loadLog();
    log.info('start_inputs', { githubToken: 'ghs_abc', label: 'runner-xyz' });
    const payload = JSON.parse(coreMock.info.mock.calls[0][0]);
    expect(payload.githubToken).toBe('***');
    expect(payload.label).toBe('runner-xyz');
  });
});
