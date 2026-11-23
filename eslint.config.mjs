// ESLint for arcium frontend: `npm run lint` (part of `npm run check`, which a pull request must pass).
//
// Next's recommended rules (React, hooks, accessibility basics, Core Web Vitals) and the TypeScript rules, plus a
// few house rules that keep the code easy to read for the next person. Files under src/legacy/ are older panels kept
// until rewritten with the kit: they get warnings, not errors, so they never block a change elsewhere.
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTs,

  // ── what is never linted ──
  { ignores: ['.next/**', '.next-sim/**', '.sim-db/**', 'node_modules/**', 'downloads/**', 'public/**', 'tests/gui/out/**', 'next-env.d.ts'] },

  // ── house rules: everywhere ──
  {
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': ['warn', { allow: ['info', 'warn', 'error'] }],   // server logs say what level they are
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // The database layer reads loosely typed rows; say so where it happens instead of failing the build.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Plain <img> is fine for the small logos and icons this site uses (next/image needs a loader on the server).
      '@next/next/no-img-element': 'off',
      // React Compiler advice (state set inside an effect, Date.now() or a ref read while rendering). Each one found
      // is a cleanup target, not a bug: they show as warnings until the files are reworked one at a time.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
    },
  },

  // ── the database layer: rows come back loosely typed from SQL and are shaped where they are used ──
  { files: ['src/lib/db.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },

  // ── scripts and tests run in Node and print on purpose ──
  {
    files: ['scripts/**', 'tests/**', '*.mjs'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-require-imports': 'off' },
  },

  // ── legacy panels: reported, never blocking ──
  {
    files: ['src/legacy/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
];

export default config;
