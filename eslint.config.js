import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'drizzle/**',
      '.freebuff/**',
      // Compile-time-only fixtures: excluded from tsconfig by design, so the
      // project service cannot type them. The compile test runs tsc directly.
      'tests/type-level/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // v16 §T.11: AutoMod must never reach Kick/Ban/Jail. The narrowed
    // AutoModEnforcer type already makes those compile errors; this lint
    // rule closes the indirect path (a direct service import).
    files: ['src/features/automod/**/*.ts'],
    ignores: ['src/features/automod/index.ts', 'src/features/automod/manifest.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/features/moderation/jail*',
                '**/features/moderation/services/jail*',
                '**/features/moderation/ban*',
                '**/features/moderation/kick*',
                '**/core/moderation/severe*',
                '**/core/moderation/punishment*',
              ],
              message:
                'AutoMod must never import Kick/Ban/Jail services. Its only enforcement surface is the narrowed AutoModEnforcer contract (LOG/DELETE/WARN/MUTE).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Test doubles are `async` to satisfy a Promise-returning contract while
      // returning pre-canned values; awaiting nothing is the point.
      '@typescript-eslint/require-await': 'off',
    },
  },
);