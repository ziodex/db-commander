import type { DatabaseSync } from 'node:sqlite'
import type { AdministrationChange, AdministrationResult } from '../shared/database-administration'
import { quoteIdentifier } from '../shared/sql/common'
import type { AdministrationPlan } from './reviews'

export function planSqliteAdministration(db: DatabaseSync, database: string, readOnly: boolean, change: AdministrationChange): AdministrationPlan {
  if ('database' in change || change.schema !== 'main' || !['analyze-table', 'reindex-table', 'check-table'].includes(change.action)) {
    throw new Error('SQLite maintenance is available only for tables in the main database.')
  }
  const { table, action } = change
  if (action !== 'check-table' && (readOnly || db.prepare('PRAGMA query_only').get()?.query_only !== 0)) {
    throw new Error('This SQLite connection is read-only. Only integrity checks are available.')
  }
  if (action !== 'check-table' && db.prepare('PRAGMA database_list').all().some(row => row.name !== 'main' && row.name !== 'temp')) {
    throw new Error('Detach other SQLite files before applying table maintenance that needs a write lock.')
  }
  const target = `"main".${quoteIdentifier(table)}`
  const current = db.prepare(`SELECT s.rootpage, substr(s.sql,1,32769) AS definition FROM main.sqlite_schema s
    JOIN pragma_table_list() t ON t.schema='main' AND t.name=s.name AND t.type='table'
    WHERE s.name=? AND s.type='table' AND s.rootpage>0 AND lower(substr(s.name,1,7))<>'sqlite_'`).get(table)
  if (!current?.rootpage || typeof current.definition !== 'string') throw new Error('Select an ordinary table in the main SQLite database.')
  const indexes = db.prepare(`SELECT name, rootpage, substr(sql,1,32769) AS definition FROM main.sqlite_schema
    WHERE tbl_name=? AND type='index' ORDER BY name LIMIT 201`).all(table)
  if (current.definition.length > 32768 || indexes.length > 200 ||
    indexes.reduce((size, index) => size + String(index.definition ?? '').length, 0) > 262144 ||
    indexes.some(index => String(index.definition ?? '').length > 32768)) throw new Error('The table or its indexes exceed the SQLite review limit.')
  if (action === 'reindex-table' && !indexes.length) throw new Error('This table has no stored indexes to rebuild.')
  const statements = {
    'analyze-table': [`ANALYZE ${target};`, 'Updates planner statistics for this table and its indexes. Query plans can change.'],
    'reindex-table': [`REINDEX ${target};`, 'Rebuilds this table’s indexes. SQLite can block other writes while it holds the database write lock.'],
    'check-table': [`PRAGMA main.integrity_check('${table.replaceAll("'", "''")}');`, 'Checks this table and its indexes. Whole-file consistency and foreign keys are outside this check.']
  }
  const [sql, note] = statements[action as keyof typeof statements]
  return {
    database, observer: 'local', scope: 'SQLite · main', target, sql,
    notes: [note, action === 'check-table' ? 'Reads a snapshot on the idle SQLite connection.' :
      'Commits this change on the idle SQLite connection. The app rechecks the table and indexes under the database write lock.'],
    fingerprint: JSON.stringify([db.prepare('PRAGMA main.schema_version').get()?.schema_version, current, indexes])
  }
}

export function applySqliteAdministration(db: DatabaseSync, database: string, readOnly: boolean, change: AdministrationChange, reviewed: AdministrationPlan): AdministrationResult {
  const timeout = db.prepare('PRAGMA busy_timeout').get()?.timeout
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 0) throw new Error('Could not read SQLite lock settings.')
  const check = change.action === 'check-table'
  db.exec('PRAGMA busy_timeout=1000')
  try {
    db.exec(check ? 'BEGIN' : 'BEGIN IMMEDIATE')
    const fresh = planSqliteAdministration(db, database, readOnly, change)
    if (fresh.fingerprint !== reviewed.fingerprint || fresh.sql !== reviewed.sql) {
      throw new Error('The reviewed SQLite table or indexes changed. Refresh the catalog and prepare a new review.')
    }
    if (check) {
      const rows = db.prepare(reviewed.sql).all()
      db.exec('COMMIT')
      if (!rows.length || rows.some(row => typeof row.integrity_check !== 'string')) {
        return { status: 'unknown', message: 'SQLite did not return an integrity result. Inspect the table and indexes before trying again.' }
      }
      if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
        return { status: 'issues', message: 'SQLite found integrity issues in the reviewed table or its indexes.' }
      }
      return { status: 'applied', message: 'SQLite reported no integrity issues in the reviewed table or its indexes.' }
    }
    db.exec(reviewed.sql)
    db.exec('COMMIT')
    return { status: 'applied', message: 'SQLite committed the reviewed operation.' }
  } finally {
    try { if (db.isTransaction) db.exec('ROLLBACK') }
    finally { db.exec(`PRAGMA busy_timeout=${timeout}`) }
  }
}
