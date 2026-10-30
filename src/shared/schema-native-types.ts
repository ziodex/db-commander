import type { DatabaseEngine } from './database-engines'

export type NativeModifier = 'none' | 'length' | 'numeric' | 'temporal'
export interface NativeTypeOption { name: string; modifier: NativeModifier; max?: number }
const plain = (...names: string[]): NativeTypeOption[] => names.map(name => ({ name, modifier: 'none' }))
const length = (max: number, ...names: string[]): NativeTypeOption[] => names.map(name => ({ name, modifier: 'length', max }))
const numeric = (max: number, ...names: string[]): NativeTypeOption[] => names.map(name => ({ name, modifier: 'numeric', max }))
const temporal = (max: number, ...names: string[]): NativeTypeOption[] => names.map(name => ({ name, modifier: 'temporal', max }))
const mysql = [...plain('TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT', 'FLOAT', 'DOUBLE', 'DATE', 'YEAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'JSON'), ...length(255, 'CHAR', 'BINARY'), ...length(65535, 'VARCHAR', 'VARBINARY'), ...numeric(65, 'DECIMAL'), ...temporal(6, 'TIME', 'DATETIME', 'TIMESTAMP')]
const mssql = [...plain('TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'BIT', 'REAL', 'FLOAT', 'MONEY', 'SMALLMONEY', 'DATE', 'DATETIME', 'SMALLDATETIME', 'UNIQUEIDENTIFIER', 'XML'), ...length(8000, 'CHAR', 'VARCHAR', 'BINARY', 'VARBINARY'), ...length(4000, 'NCHAR', 'NVARCHAR'), ...numeric(38, 'DECIMAL', 'NUMERIC'), ...temporal(7, 'TIME', 'DATETIME2', 'DATETIMEOFFSET')]
export const nativeTypes: Record<DatabaseEngine, NativeTypeOption[]> = {
  postgres: [...plain('SMALLINT', 'INTEGER', 'BIGINT', 'REAL', 'DOUBLE PRECISION', 'BOOLEAN', 'TEXT', 'BYTEA', 'UUID', 'JSON', 'JSONB', 'DATE', 'INTERVAL', 'POINT', 'TSVECTOR', 'TSQUERY', 'INET', 'CIDR', 'MACADDR'), ...length(10485760, 'CHAR', 'VARCHAR', 'BIT', 'VARBIT'), ...numeric(1000, 'NUMERIC'), ...temporal(6, 'TIME', 'TIME WITH TIME ZONE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE')],
  mysql, mariadb: mysql,
  sqlserver: mssql, 'azure-sql': mssql,
  sqlite: plain('INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC'),
  duckdb: [...plain('TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT', 'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'UHUGEINT', 'REAL', 'DOUBLE', 'BOOLEAN', 'VARCHAR', 'BLOB', 'UUID', 'JSON', 'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL'), ...numeric(38, 'DECIMAL')],
  oracle: [...plain('BINARY_FLOAT', 'BINARY_DOUBLE', 'DATE', 'CLOB', 'NCLOB', 'BLOB'), ...length(4000, 'VARCHAR2'), ...length(2000, 'NVARCHAR2', 'CHAR', 'NCHAR', 'RAW'), ...numeric(38, 'NUMBER'), ...temporal(9, 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH LOCAL TIME ZONE')]
}
export const supportsNamedNativeType = (engine: DatabaseEngine) => ['postgres', 'sqlserver', 'azure-sql', 'duckdb', 'oracle'].includes(engine)
export const supportsNativeArray = (engine: DatabaseEngine) => engine === 'postgres' || engine === 'duckdb'
