import { z } from 'zod'
import type { DatabaseEngine } from './contracts'

const text = z.string().trim().min(1).max(4096).refine(value => !/[\u0000-\u001f]/.test(value), 'Control characters are not allowed.')
export const backupRequestSchema = z.object({
  sessionId: z.uuid(), action: z.enum(['backup', 'restore']),
  // Local file, SQL Server server-side file, Oracle dump filename, or Azure copy name.
  artifact: text, target: text.optional(), toolDirectory: text.optional(),
  directory: text.optional(), sourceSchema: text.optional(),
  content: z.enum(['all', 'schema']).default('all'), confirmed: z.literal(true)
}).strict().superRefine((value, ctx) => {
  if (value.action === 'restore' && !value.target) ctx.addIssue({ code: 'custom', message: 'Choose a new restore target.' })
})
export type BackupRequest = z.infer<typeof backupRequestSchema>
export interface BackupJob {
  id: string; sessionId: string; engine: DatabaseEngine; action: 'backup' | 'restore';
  database: string; server?: string; artifact: string; target?: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  phase: string; log: string[]; cancellationRequested?: boolean
  /** Transient local journal warning; independent of the operation's outcome. */
  historyError?: string
}
interface BackupCapability { format: string; location: 'local' | 'server' | 'directory' | 'cloud'; extension: string; schemaOnly: boolean; description: string }
export const backupCapabilities: Record<DatabaseEngine, BackupCapability> = {
  postgres: { format: 'PostgreSQL custom archive', location: 'local', extension: 'dump', schemaOnly: true, description: 'Consistent pg_dump archive, restored with pg_restore into a new database. Install matching PostgreSQL client tools. Server roles and tablespaces are not included; restored objects belong to your login.' },
  mysql: { format: 'MySQL SQL dump', location: 'local', extension: 'sql', schemaOnly: true, description: 'mysqldump / mysql client tools. Includes routines, triggers and events. Full backups require InnoDB tables. Avoid schema changes during backup; external users and grants are not included.' },
  mariadb: { format: 'MariaDB SQL dump', location: 'local', extension: 'sql', schemaOnly: true, description: 'mariadb-dump / mariadb client tools. Includes routines, triggers and events. Full backups require InnoDB tables. Avoid schema changes during backup; external users and grants are not included.' },
  sqlserver: { format: 'SQL Server native backup (.bak)', location: 'server', extension: 'bak', schemaOnly: false, description: 'COPY_ONLY full backup with checksums. Paths belong to the database server and must be accessible to its service account. Restore creates a new database and moves its data/log files to the server’s default directories. No REPLACE or overwrites.' },
  'azure-sql': { format: 'Azure SQL database recovery copy', location: 'cloud', extension: '', schemaOnly: false, description: 'Creates an independent, transactionally consistent database copy on the same logical server. Restore copies that recovery database to a new name. Copies incur Azure charges and remain until you delete them. This is not an offline archive, BACPAC export, or point-in-time recovery.' },
  oracle: { format: 'Oracle Data Pump schema dump', location: 'directory', extension: 'dmp', schemaOnly: true, description: 'Exports one schema to an Oracle DIRECTORY on the server. Restore remaps it into a new schema-only account. Requires DIRECTORY access; restore also requires CREATE USER and Data Pump import privileges. Schema-qualified references in views or PL/SQL may need manual changes after remapping. No CDB/PDB or RMAN recovery. Stop schema changes during export.' },
  sqlite: { format: 'SQLite database snapshot', location: 'local', extension: 'sqlite', schemaOnly: false, description: 'Uses SQLite’s online backup API, including committed WAL content. Restores into a new file after an integrity check. Only the main database is included; attached and temporary databases are excluded.' },
  duckdb: { format: 'DuckDB database snapshot', location: 'local', extension: 'duckdb', schemaOnly: true, description: 'Copies the selected catalog using native export/import, including constraints, indexes, sequences and macros. Requires temporary disk space for a Parquet export and the new database file. Other attached catalogs and temporary objects are excluded.' }
}
