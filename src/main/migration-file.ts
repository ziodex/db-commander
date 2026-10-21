import { writeGeneratedFile } from './generated-file'

/** Publish a complete migration to a new destination, never over an existing file. */
export async function writeMigrationFile(path: string, sql: string) {
  if (!path.toLowerCase().endsWith('.sql')) throw new Error('Choose a new filename ending in .sql.')
  try { await writeGeneratedFile(path, sql) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This file already exists. Choose a new migration filename; existing migrations are never replaced.'); throw error }
}
