import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'dist/', 'test-results/', '.e2e-artifacts/'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Content scripts are classic scripts that share one isolated-world scope.
    files: ['src/content/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        GLINT_LANGUAGES: 'readonly',
        GLINT_PARSE_DICTIONARY: 'readonly',
        GLINT_CARD_CSS: 'readonly',
        GLINT_PAGE_CSS: 'readonly',
        GLINT_ICONS: 'readonly',
        GLINT_DOM: 'readonly',
      },
    },
  },
  {
    files: ['src/shared/languages.js', 'src/shared/dictionary.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['scripts/**', 'test/**', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
