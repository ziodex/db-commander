import parser from '@typescript-eslint/parser'
import hooks from 'eslint-plugin-react-hooks'
import { builtinModules } from 'node:module'

const backend = ['main', 'preload', 'driver', 'storage', 'files', 'credentials', 'connections', 'backup', 'activity', 'catalog', 'schema', 'transfer', 'data', 'explain', 'query-builder']
const restricted = (areas, native = false) => ['error', {
  patterns: [
    { regex: `^(?:(?:\\.\\./)+|src/)(?:${areas.join('|')})(?:/|$)`, message: 'Import through the shared contract; this module belongs to a separate runtime layer.' },
    ...(native ? [{ group: [...builtinModules, 'node:*', 'electron', 'pg', 'pg-*', 'mysql2', 'mysql2/*', 'mariadb', 'tedious', 'oracledb', '@duckdb/*', '@napi-rs/*'], message: 'Privileged runtime APIs belong behind the preload/host boundary.' }] : [])
  ]
}]

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'react-hooks': hooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' }
  },
  { files: ['src/renderer/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': restricted(backend, true) } },
  { files: ['src/shared/**/*.ts'], rules: { 'no-restricted-imports': restricted([...backend, 'renderer', 'language'], true) } },
  { files: ['src/language/**/*.ts'], rules: { 'no-restricted-imports': restricted([...backend, 'renderer'], true) } },
  { files: ['src/preload/**/*.ts'], rules: { 'no-restricted-imports': restricted([...backend.filter(area => area !== 'preload'), 'renderer', 'language']) } },
  {
    files: backend.filter(area => !['main', 'preload'].includes(area)).map(area => `src/${area}/**/*.ts`),
    rules: {
      'no-restricted-imports': ['error', {
        ...restricted(['main', 'preload', 'renderer'])[1],
        paths: ['electron', 'react', 'react-dom', 'react-dom/client']
      }]
    }
  }
]
