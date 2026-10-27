import { rm } from 'node:fs/promises'

// Resolve from this script so invoking it from another directory stays safe.
const root = new URL('../', import.meta.url)
const outputs = ['out', 'release', 'coverage', 'test-results', 'playwright-report', '.test-artifacts']
for (const directory of outputs) {
  await rm(new URL(directory, root), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  console.log(`Removed ${directory}/`)
}
