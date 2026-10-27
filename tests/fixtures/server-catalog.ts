import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig } from '../../src/shared/contracts'
export const SERVER_CATALOG_TABLES = 1300
export const SERVER_CATALOG_OVERFLOW = 2105
export const serverCatalogTable = (prefix: string, index: number) => prefix + String(index).padStart(4, '0')
/** Synthetic server DDL. Batches stay below the public 200-statement budget. */
export function serverCatalogSeed(engine: ConnectionConfig['engine'], prefix: string, start: number, end: number) {
  const q = (name: string) => quoteIdentifier(name, engine)
  return Array.from({ length: end - start }, (_, offset) => {
    const table = q(serverCatalogTable(prefix, start + offset))
    return `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label VARCHAR(80) NOT NULL UNIQUE, other_label VARCHAR(80) UNIQUE, parent_id INTEGER, amount INTEGER CHECK(amount >= 0), flag SMALLINT, created_at VARCHAR(40), note VARCHAR(80) DEFAULT 'fixture', FOREIGN KEY(parent_id) REFERENCES ${table}(id));`
  }).join('\n')
}
