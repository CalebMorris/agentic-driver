const tseslint = require('typescript-eslint');

// Silent-catch policy (all core ESLint rules, per their docs):
// - no-empty: rejects `catch {}` / `catch (e) {}` (comment-only blocks are exempt by design)
// - no-restricted-syntax CatchClause[param=null]: rejects bindingless `catch { ... }`,
//   closing the comment-only loophole no-empty leaves open
// - no-unused-vars caughtErrors:'all' (ESLint 9 default): rejects a bound-but-unused error
// - caughtErrorsIgnorePattern '^_': the sanctioned escape hatch — `catch (_error)`
//   declares an intentional ignore
module.exports = [
  {
    ignores: ['**/node_modules/**', '**/dist/**'],
  },
  {
    files: ['mcp/src/**/*.ts', 'server/src/**/*.ts', 'plugin/**/*.js'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-empty': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause[param=null]',
          message:
            'Bind the error: `catch (error)`. Handle or log it, or name it `_error` to declare an intentional ignore.',
        },
      ],
      'no-unused-vars': [
        'error',
        { vars: 'local', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_', args: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // MV3 service worker + popup are classic scripts, not modules; their top-level
    // declarations are globals that Playwright reaches via worker.evaluate().
    files: ['plugin/**/*.js'],
    languageOptions: {
      sourceType: 'script',
    },
  },
];
