import { build } from 'vite'
import { resolve } from 'node:path'
import { buildWindowsOwnerGuard } from './build-windows-owner-guard.mjs'
// Retain out/main for the standalone Docker adapter fixture; release builds
// place a self-contained copy outside ASAR, with no relative/npm requires.
await build({ configFile: false, ssr: { noExternal: true }, build: { ssr: true, emptyOutDir: false, outDir: process.argv[2] ?? 'out/main',
  lib: { entry: resolve('src/driver/sqlite-worker.ts'), formats: ['cjs'], fileName: () => 'sqlite-worker.cjs' },
  rollupOptions: { output: { format: 'cjs', entryFileNames: 'sqlite-worker.cjs' }, external: id => id.startsWith('node:') } } })
buildWindowsOwnerGuard(process.argv[2] ?? 'out/main')
