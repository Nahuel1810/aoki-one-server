// @ts-check
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      'public-dist/',
      'coverage/',
      'packages/web/',
      'src/',
      'tests/',
      'scripts/',
      'data/',
      'public/',
    ],
  },
  {
    files: ['packages/{domain,agent,server}/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // Los *.test.ts estan excluidos de los tsconfig de cada paquete (para que
        // `tsc -b` no los emita a dist/), asi que projectService no los encuentra.
        // tsconfig.eslint.json es el proyecto que si los incluye.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',

      // El guion bajo marca "declarado a proposito y no usado". Sin esto el gate de lint
      // contradice al de tipos: noUnusedParameters de tsc si acepta el prefijo, y toda
      // firma sin implementar y todo doble de puerto rompe el lint.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
)
