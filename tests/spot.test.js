// Tests for spot support: buildMarketOptions, buildMarketPlan, and the
// launchAcrossMarkets orchestration (spot → on-demand fallback). The
// per-market attempt fns are injected so the fallback logic is tested
// without the AWS SDK. config + core are mocked (aws.js reaches log.js).
jest.mock('../src/config', () => ({
  input: { mode: 'start', debug: 'false' },
  githubContext: { owner: 'o', repo: 'r' },
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setFailed: jest.fn(), getInput: jest.fn(),
  startGroup: jest.fn(), endGroup: jest.fn(),
}));

const { buildMarketOptions, buildMarketPlan, launchAcrossMarkets } = require('../src/aws');

const err = (name) => Object.assign(new Error(name), { name });
const capacity = () => err('InsufficientInstanceCapacity');

describe('buildMarketOptions', () => {
  test('returns undefined for on-demand (zero param diff)', () => {
    expect(buildMarketOptions('on-demand')).toBeUndefined();
    expect(buildMarketOptions('on-demand', '0.05')).toBeUndefined();
  });

  test('builds a one-time, terminate-on-interruption spot request', () => {
    expect(buildMarketOptions('spot')).toEqual({
      MarketType: 'spot',
      SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' },
    });
  });

  test('includes MaxPrice only when provided', () => {
    expect(buildMarketOptions('spot', '0.05').SpotOptions.MaxPrice).toBe('0.05');
    expect(buildMarketOptions('spot', '').SpotOptions.MaxPrice).toBeUndefined();
  });
});

describe('buildMarketPlan', () => {
  test('on-demand → only on-demand', () => {
    expect(buildMarketPlan('on-demand', 'on-demand')).toEqual(['on-demand']);
  });
  test('spot with default fallback → spot then on-demand', () => {
    expect(buildMarketPlan('spot', 'on-demand')).toEqual(['spot', 'on-demand']);
  });
  test('spot with fail fallback → spot only', () => {
    expect(buildMarketPlan('spot', 'fail')).toEqual(['spot']);
  });
});

describe('launchAcrossMarkets', () => {
  test('returns the spot placement when spot succeeds (no on-demand attempt)', async () => {
    const attemptFor = jest.fn((market) => jest.fn().mockResolvedValue([`i-${market}`]));
    const result = await launchAcrossMarkets(attemptFor, ['spot', 'on-demand'], ['t1'], ['s1']);
    expect(result).toMatchObject({ instanceIds: ['i-spot'], marketType: 'spot' });
    expect(attemptFor).toHaveBeenCalledTimes(1); // on-demand attempt fn never built
  });

  test('falls back to on-demand exactly once when spot capacity is exhausted', async () => {
    const spotAttempt = jest.fn().mockRejectedValue(capacity());
    const onDemandAttempt = jest.fn().mockResolvedValue(['i-od']);
    const attemptFor = (market) => (market === 'spot' ? spotAttempt : onDemandAttempt);
    const onDowngrade = jest.fn();

    const result = await launchAcrossMarkets(attemptFor, ['spot', 'on-demand'], ['t1'], ['s1'], { onDowngrade });

    expect(result).toMatchObject({ instanceIds: ['i-od'], marketType: 'on-demand' });
    expect(spotAttempt).toHaveBeenCalledTimes(1);
    expect(onDemandAttempt).toHaveBeenCalledTimes(1);
    expect(onDowngrade).toHaveBeenCalledWith('spot', 'on-demand', expect.anything());
  });

  test('falls back on SpotMaxPriceTooLow (price is a capacity-class code)', async () => {
    const spotAttempt = jest.fn().mockRejectedValue(err('SpotMaxPriceTooLow'));
    const onDemandAttempt = jest.fn().mockResolvedValue(['i-od']);
    const attemptFor = (market) => (market === 'spot' ? spotAttempt : onDemandAttempt);
    const result = await launchAcrossMarkets(attemptFor, ['spot', 'on-demand'], ['t1'], ['s1']);
    expect(result.marketType).toBe('on-demand');
  });

  test('spot-fallback: fail propagates the capacity error (no on-demand)', async () => {
    const spotAttempt = jest.fn().mockRejectedValue(capacity());
    const attemptFor = () => spotAttempt;
    await expect(launchAcrossMarkets(attemptFor, ['spot'], ['t1'], ['s1'])).rejects.toMatchObject({ capacityExhausted: true });
  });

  test('a fatal spot error aborts without falling back to on-demand', async () => {
    const spotAttempt = jest.fn().mockRejectedValue(err('InvalidAMIID.NotFound'));
    const onDemandAttempt = jest.fn().mockResolvedValue('i-od');
    const attemptFor = (market) => (market === 'spot' ? spotAttempt : onDemandAttempt);
    await expect(launchAcrossMarkets(attemptFor, ['spot', 'on-demand'], ['t1'], ['s1'])).rejects.toThrow('InvalidAMIID.NotFound');
    expect(onDemandAttempt).not.toHaveBeenCalled();
  });
});
