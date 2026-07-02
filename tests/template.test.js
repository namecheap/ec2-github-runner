// Tests for user-data template rendering + size guard (src/template.js).
const { renderUserDataTemplate, assertUserDataSize, MAX_USER_DATA_BYTES } = require('../src/template');

const vars = {
  RUNNER_VERSION: '2.335.1',
  RUNNER_CHECKSUM_X64: 'x64sha',
  RUNNER_CHECKSUM_ARM64: 'arm64sha',
  REGISTRATION_TOKEN: 'SECRET-TOKEN',
  REPO_URL: 'https://github.com/my-org/my-repo',
  LABEL: 'runner-abc12',
  TTL_MINUTES: '360',
};

describe('renderUserDataTemplate', () => {
  test('substitutes every documented placeholder', () => {
    const tpl = 'v={{RUNNER_VERSION}} x={{RUNNER_CHECKSUM_X64}} a={{RUNNER_CHECKSUM_ARM64}} t={{REGISTRATION_TOKEN}} u={{REPO_URL}} l={{LABEL}} ttl={{TTL_MINUTES}}';
    expect(renderUserDataTemplate(tpl, vars)).toBe(
      'v=2.335.1 x=x64sha a=arm64sha t=SECRET-TOKEN u=https://github.com/my-org/my-repo l=runner-abc12 ttl=360',
    );
  });

  test('substitutes repeated placeholders', () => {
    expect(renderUserDataTemplate('{{LABEL}}-{{LABEL}}', vars)).toBe('runner-abc12-runner-abc12');
  });

  test('leaves unused known placeholders absent without error', () => {
    expect(renderUserDataTemplate('only {{LABEL}}', vars)).toBe('only runner-abc12');
  });

  test('throws listing unknown placeholders (typo protection)', () => {
    expect(() => renderUserDataTemplate('{{RUNNER_VERION}} {{FOO}}', vars)).toThrow(/RUNNER_VERION, FOO/);
  });

  test('renders the token so the runner can register (secret handled by caller redaction)', () => {
    expect(renderUserDataTemplate('--token {{REGISTRATION_TOKEN}}', vars)).toContain('SECRET-TOKEN');
  });
});

describe('assertUserDataSize', () => {
  test('passes payloads within the 16 KB limit', () => {
    const ud = 'a'.repeat(1000);
    expect(assertUserDataSize(ud)).toBe(ud);
  });

  test('throws for payloads over the limit', () => {
    const ud = 'a'.repeat(MAX_USER_DATA_BYTES + 1);
    expect(() => assertUserDataSize(ud)).toThrow(/over the EC2 limit/);
  });

  test('counts bytes, not characters (multibyte)', () => {
    // Each '€' is 3 bytes in UTF-8.
    const ud = '€'.repeat(Math.ceil(MAX_USER_DATA_BYTES / 3) + 1);
    expect(() => assertUserDataSize(ud)).toThrow(/over the EC2 limit/);
  });
});
