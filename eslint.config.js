const js = require('@eslint/js'); // explicit dep: eslint@10 no longer bundles it
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
