// Tests for AMI architecture validation (matchAmiArchitecture). config + core
// are mocked because aws.js reaches log.js at require time.
jest.mock('../src/config', () => ({
  input: { mode: 'start', debug: 'false' },
  githubContext: { owner: 'o', repo: 'r' },
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setFailed: jest.fn(), getInput: jest.fn(),
  startGroup: jest.fn(), endGroup: jest.fn(),
}));

const { matchAmiArchitecture } = require('../src/aws');

describe('matchAmiArchitecture', () => {
  test('x86_64 AMI matches x64', () => {
    expect(matchAmiArchitecture('x86_64', 'x64')).toBe(true);
  });
  test('arm64 AMI matches arm64', () => {
    expect(matchAmiArchitecture('arm64', 'arm64')).toBe(true);
  });
  test('x86_64 AMI mismatches arm64', () => {
    expect(matchAmiArchitecture('x86_64', 'arm64')).toBe(false);
  });
  test('arm64 AMI mismatches x64', () => {
    expect(matchAmiArchitecture('arm64', 'x64')).toBe(false);
  });
  test('unknown/absent AMI architecture returns null (warn-and-continue)', () => {
    expect(matchAmiArchitecture(undefined, 'x64')).toBeNull();
    expect(matchAmiArchitecture('', 'arm64')).toBeNull();
  });
});
