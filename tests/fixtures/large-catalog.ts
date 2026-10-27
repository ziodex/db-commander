/** Synthetic embedded catalogs only; no user data or external database access. */
export const LARGE_CATALOG_TABLES = 1300
export const OVERFLOW_CATALOG_TABLES = 2105
export function catalogTable(index: number) { return `bulk_${String(index).padStart(4, '0')}` }
export function catalogSeed(start: number, end: number) {
  return 'BEGIN;\n' + Array.from({ length: end - start }, (_, n) => {
    const name = catalogTable(start + n)
    return `CREATE TABLE "${name}" (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE, other_label TEXT UNIQUE, parent_id INTEGER REFERENCES "${name}"(id), amount INTEGER CHECK(amount >= 0), flag BOOLEAN, created_at VARCHAR(40), note TEXT DEFAULT '');`
  }).join('\n') + '\nCOMMIT;'
}
export function attachedCatalogSeed(engine: 'sqlite' | 'duckdb') {
  return engine === 'sqlite'
    ? `ATTACH ':memory:' AS zz_attached; CREATE TABLE zz_attached.attached_tail(id INTEGER PRIMARY KEY, note TEXT); CREATE VIEW zz_attached.attached_view AS SELECT id FROM attached_tail;`
    : `ATTACH ':memory:' AS zz_attached; CREATE TABLE zz_attached.main.attached_tail(id INTEGER PRIMARY KEY, note TEXT); CREATE VIEW zz_attached.main.attached_view AS SELECT id FROM zz_attached.main.attached_tail;`
}
