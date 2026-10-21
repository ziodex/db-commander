import { z } from 'zod'

export const engineSchema = z.enum(['postgres', 'mysql', 'mariadb', 'sqlserver', 'azure-sql', 'sqlite', 'oracle', 'duckdb'])
export type DatabaseEngine = z.infer<typeof engineSchema>
export const engineNames: Record<DatabaseEngine, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlserver: 'SQL Server', 'azure-sql': 'Azure SQL', sqlite: 'SQLite', oracle: 'Oracle Database', duckdb: 'DuckDB' }

export const defaultPorts: Record<DatabaseEngine, number> = { postgres: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, 'azure-sql': 1433, sqlite: 1, oracle: 1521, duckdb: 1 }
