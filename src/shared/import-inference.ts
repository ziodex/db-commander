import type { Cell, DatabaseEngine } from './contracts'
import { schemaColumnSchema, type SchemaColumnInput } from './schema-changes'

/** Suggestions only: leading zeros, oversized numbers and ambiguous values stay
 * text. Nullability remains permissive because a sample cannot prove NOT NULL. */
export function inferImportColumns(engine: DatabaseEngine, headers: string[], rows: Cell[][]): SchemaColumnInput[] {
  const names = new Set<string>()
  return headers.map((header, index) => {
    let name = schemaColumnSchema.shape.name.safeParse(header).success ? header : `column_${index + 1}`
    if (names.has(name.toLowerCase())) name = `column_${index + 1}`
    while (names.has(name.toLowerCase()) || name !== header && headers.some(header => header.toLowerCase() === name.toLowerCase())) name += '_'
    names.add(name.toLowerCase())
    const values = rows.map(row => row[index]).filter((value): value is string => value !== null && value !== undefined)
    let type: SchemaColumnInput['type'] = engine === 'oracle' ? 'varchar' : 'text', precision = 38, scale = 0
    if (values.length && values.every(value => /^(?:0|-?[1-9]\d*)$/.test(value) && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n)) type = 'bigint'
    else if (engine !== 'sqlite' && values.length && values.every(value => /^(?:0|-?[1-9]\d*)\.\d+$/.test(value))) {
      scale = Math.max(...values.map(value => value.split('.')[1].length))
      const integer = Math.max(...values.map(value => value.replace(/^-/, '').split('.')[0].length))
      if (integer + scale <= 38 && scale <= 30) { type = 'decimal'; precision = integer + scale }
    } else if (['postgres', 'duckdb', 'sqlite'].includes(engine) && values.length && values.every(value => /^(true|false)$/.test(value))) type = 'boolean'
    return schemaColumnSchema.parse({ name, type, length: 4000, precision, scale, nullable: true })
  })
}
