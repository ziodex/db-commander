import type { Cell, GridChange, GridColumn, GridSnapshot } from '../shared/contracts'
import { GridSql } from './grid-sql'

/** The preview and execution share this builder; original keys come only from
 * the host-owned snapshot, and all values remain bound parameters. */
export function gridDml(d: GridSql, snapshot: GridSnapshot, change: GridChange) {
  const target = d.table(snapshot.table), values: Cell[] = []
  const bind = (column: GridColumn, value: Cell, assignment = false) => {
    values.push(value)
    // An explicit PostgreSQL CAST to varchar(n) silently truncates, whereas
    // assignment lets the target enforce its length. Binary is decoded from
    // the explicitly validated hexadecimal transport representation.
    return assignment && d.engine === 'postgres' && !d.binary(column) ? d.p(values.length) : d.value(column, values.length)
  }
  let sql: string
  if (change.kind === 'insert') {
    const columns = change.values.map(value => d.q(snapshot.columns[value.column].name))
    const placeholders = change.values.map(value => bind(snapshot.columns[value.column], value.value, true))
    sql = columns.length ? `INSERT INTO ${target} (${columns.join(',')}) VALUES (${placeholders.join(',')})` : d.mysql ? `INSERT INTO ${target} () VALUES ()` : d.engine === 'oracle' ? `INSERT INTO ${target} (${d.q(snapshot.columns[0].name)}) VALUES (DEFAULT)` : `INSERT INTO ${target} DEFAULT VALUES`
  } else {
    const set = change.kind === 'update' ? change.values.map(value => `${d.q(snapshot.columns[value.column].name)}=${bind(snapshot.columns[value.column], value.value, true)}`).join(',') : ''
    const where = snapshot.columns.flatMap((column, index) => column.primaryKey ? [`${d.q(column.name)}=${bind(column, snapshot.rows[change.row][index])}`] : []).join(' AND ')
    sql = change.kind === 'update' ? `UPDATE ${target} SET ${set} WHERE ${where}` : `DELETE FROM ${target} WHERE ${where}`
  }
  return { sql, values }
}
