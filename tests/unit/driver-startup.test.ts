import { expect, it, vi } from 'vitest'
import { MAX_TABS } from '../../src/shared/contracts'

vi.mock('@duckdb/node-api', () => { throw new Error('The native DuckDB library cannot be loaded.') })

it('initializes the registry and contains repeated native DuckDB load failures', async () => {
  const { DriverRegistry } = await import('../../src/driver/registry')
  const registry = new DriverRegistry(() => {})
  const profile = { name: 'Startup regression', host: 'local', port: 1, user: 'local', database: '', password: '', tls: 'disable' as const }
  try {
    // Failed native loads must release their reserved connection slots.
    for (let attempt = 0; attempt <= MAX_TABS; attempt++) {
      await expect(registry.connect({ ...profile, engine: 'duckdb', duckdbMode: 'memory' })).rejects.toThrow('DuckDB native library')
    }
  } finally { await registry.close() }
})
