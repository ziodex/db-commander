import { z } from 'zod'
import { MAX_SQL_CHARACTERS } from './workspace-limits'

export const SQL_FILE_LIMIT = MAX_SQL_CHARACTERS
export const SQL_FILE_REGISTRY_VERSION = 2
const sqlFileCommandSchema = z.enum(['open', 'save', 'save-as', 'recent', 'reload'])
export type SqlFileCommand = z.infer<typeof sqlFileCommandSchema>
export const openSqlFileSchema = z.object({ tabId: z.string().uuid(), recentId: z.string().uuid().optional(), projectEntryId: z.string().uuid().optional() }).strict()
  .refine(request => !(request.recentId && request.projectEntryId), 'Choose one SQL file source.')
export type OpenSqlFileRequest = z.infer<typeof openSqlFileSchema>
export const saveSqlFileSchema = z.object({ tabId: z.string().uuid(), sql: z.string().max(SQL_FILE_LIMIT), saveAs: z.boolean().optional() }).strict()
export type SaveSqlFileRequest = z.infer<typeof saveSqlFileSchema>
export const reloadSqlFileSchema = saveSqlFileSchema.omit({ saveAs: true })
export const finishSqlFileReloadSchema = z.object({ reloadId: z.string().uuid(), accept: z.boolean() }).strict()
export interface SqlFileInfo {
  tabId: string; path: string; name: string; savedHash: string
  external: 'unchanged' | 'changed' | 'missing' | 'unavailable'
}
export interface RecentSqlFile { id: string; path: string; name: string }
export interface SqlFilesState { files: SqlFileInfo[]; recent: RecentSqlFile[]; notice?: string }
export interface SqlProject {
  path: string; name: string; files: { id: string; relativePath: string }[]
  limited: boolean; inaccessible: boolean
}
export interface OpenedSqlFile { file: SqlFileInfo; sql: string }
export interface PreparedSqlFileReload extends OpenedSqlFile { reloadId: string }
// Monaco may normalize line endings. A line-ending-only normalization is not
// an unsaved SQL edit; disk fingerprints still compare the original bytes.
export function normalizedSql(sql: string) { return sql.replace(/\r\n/g, '\n') }
