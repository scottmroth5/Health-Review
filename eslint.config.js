// npm run lint: promise rules only, read with type information (tsconfig.lint.json). A promise nobody awaits loses its
// errors and its order; the v3 move to an async database (docs/adr) makes every statement a promise, so this is the net
// that catches a missed await. Style is not linted. A deliberate fire-and-forget is written `void promise` with a reason.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**', 'legacy/**', 'data/**', 'evals/fixtures/**', 'test/fixtures/**',
      // Under the eval harness sha gate (CLAUDE.md, Eval): any edit needs the owner's re-approval, so it is linted when
      // Phase 1B changes it anyway.
      'evals/run-review-eval.mjs',
      // Browser code: UI loaders started from clicks and timers, outside the async database move. Linted when the
      // browser code gets its own pass (docs/adr/0005).
      'server/public/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.ts', '**/*.mts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.lint.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // node:test runs top-level test() and describe() itself; their promises are safe to leave.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite', 'before', 'after', 'beforeEach', 'afterEach'] }],
      }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: true, attributes: false } }],
    },
  },
);
