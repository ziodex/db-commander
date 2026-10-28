import { DEFAULT_PROFILE, type DatabaseEngine } from '../shared/contracts'

export const INITIAL_SQL = `SELECT\n  current_database() AS database,\n  current_user AS connected_as,\n  now() AS server_time;\n`
export const INITIAL_PROFILE = DEFAULT_PROFILE
export const MYSQL_INITIAL_SQL = `SELECT DATABASE() AS database_name, CURRENT_USER() AS connected_as, NOW(6) AS server_time;\n`
export const SQLSERVER_INITIAL_SQL = `-- SQL Server / Azure SQL. GO separates batches.\nSELECT DB_NAME() AS database_name, SUSER_SNAME() AS connected_as, SYSDATETIMEOFFSET() AS server_time;\n`
export const ORACLE_INITIAL_SQL = `-- Oracle: changes need COMMIT or ROLLBACK. DDL commits implicitly.\n-- End PL/SQL blocks with a slash on its own line.\nSELECT SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS service_name, USER AS connected_as, SYSTIMESTAMP AS server_time FROM dual;\n`
export const DUCKDB_INITIAL_SQL = `SELECT version() AS duckdb_version, 42 AS answer;\n`
export const SQLITE_INITIAL_SQL = `SELECT sqlite_version() AS sqlite_version, datetime('now') AS utc_time;\n`
export function starterSql(engine: DatabaseEngine) { return engine === 'duckdb' ? DUCKDB_INITIAL_SQL : engine === 'oracle' ? ORACLE_INITIAL_SQL : engine === 'sqlite' ? SQLITE_INITIAL_SQL : engine === 'postgres' ? INITIAL_SQL : ['mysql', 'mariadb'].includes(engine) ? MYSQL_INITIAL_SQL : SQLSERVER_INITIAL_SQL }
