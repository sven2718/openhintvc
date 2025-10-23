// ESLint v9 flat config for TypeScript
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['node_modules/**', 'out/**', 'src/test/**']
  },
  // Typescript-eslint recommended with type-checking
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json'
      }
    },
    rules: {
      // Loosen rules to avoid large refactors right now
      'no-var': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off'
    }
  }
];

