const js = require('@eslint/js'); // bundled with eslint@9
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-use-before-define': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { caughtErrorsIgnorePattern: '^_' }],
    },
  },
];
