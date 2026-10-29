import type { DatabaseEngine } from '../shared/database-engines'
import { nativeTypes, supportsNamedNativeType, supportsNativeArray } from '../shared/schema-native-types'
import type { SchemaColumnInput } from '../shared/schema-changes'

type NativeType = NonNullable<SchemaColumnInput['nativeType']>
export function nativeTypeSql(type: NativeType, engine: DatabaseEngine, quote: (name: string) => string, version: string): string {
  if (type.array && !supportsNativeArray(engine)) throw new Error('Array types are not supported by this engine in the guided editor.')
  const suffix = type.array ? '[]' : ''
  if (type.kind === 'named') {
    if (!supportsNamedNativeType(engine)) throw new Error('Schema-qualified user-defined types are not supported by this engine in the guided editor.')
    if (type.catalog && engine !== 'duckdb') throw new Error('Catalog-qualified user-defined types are only supported for DuckDB.')
    return `${type.catalog ? `${quote(type.catalog)}.` : ''}${quote(type.schema)}.${quote(type.name)}${suffix}`
  }
  const option = nativeTypes[engine].find(option => option.name === type.name)
  if (!option) throw new Error('Choose a native type supported by the selected engine.')
  const hasLength = type.length !== undefined, hasNumeric = type.precision !== undefined || type.scale !== undefined, hasTemporal = type.fractional !== undefined
  let modifier = ''
  if (option.modifier === 'length') {
    if (!hasLength || type.length! > option.max! || hasNumeric || hasTemporal) throw new Error(`Choose a length from 1 to ${option.max} for ${option.name}.`)
    modifier = `(${type.length})`
  } else if (option.modifier === 'numeric') {
    const modernPostgres = engine === 'postgres' && Number(/^PostgreSQL\s+(\d+)/i.exec(version)?.[1] ?? 0) >= 15
    const minimum = engine === 'oracle' ? -84 : modernPostgres ? -1000 : 0
    const maximum = engine === 'oracle' ? 127 : engine === 'mysql' || engine === 'mariadb' ? 30 : option.max!
    const requiresScaleWithinPrecision = engine !== 'oracle' && !modernPostgres
    if (hasLength || hasTemporal || type.precision === undefined || type.scale === undefined || type.precision > option.max! || type.scale < minimum || type.scale > maximum || requiresScaleWithinPrecision && type.scale > type.precision) throw new Error(`Choose a precision up to ${option.max} and a valid scale for ${option.name}.`)
    modifier = `(${type.precision},${type.scale})`
  } else if (option.modifier === 'temporal') {
    if (hasLength || hasNumeric || type.fractional === undefined || type.fractional > option.max!) throw new Error(`Choose fractional precision from 0 to ${option.max} for ${option.name}.`)
    // SQL syntax places temporal precision before WITH ... TIME ZONE.
    const parts = option.name.split(' WITH ')
    return `${parts[0]}(${type.fractional})${parts[1] ? ` WITH ${parts[1]}` : ''}${suffix}`
  } else if (hasLength || hasNumeric || hasTemporal) throw new Error(`${option.name} does not take a modifier in this editor.`)
  return `${option.name}${modifier}${suffix}`
}

export function nativeIdentityCompatible(type: NativeType, engine: DatabaseEngine): boolean {
  if (type.kind !== 'builtin' || type.array) return false
  if (engine === 'sqlite') return type.name === 'INTEGER'
  if (engine === 'postgres') return ['SMALLINT', 'INTEGER', 'BIGINT'].includes(type.name)
  if (engine === 'mysql' || engine === 'mariadb') return ['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT'].includes(type.name)
  if (engine === 'sqlserver' || engine === 'azure-sql') return ['TINYINT', 'SMALLINT', 'INT', 'BIGINT'].includes(type.name) || ['DECIMAL', 'NUMERIC'].includes(type.name) && type.scale === 0
  if (engine === 'oracle') return type.name === 'NUMBER' && type.scale === 0
  return false
}
