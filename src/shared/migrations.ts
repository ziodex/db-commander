import { z } from 'zod'
import { idSchema, type DatabaseEngine } from './contracts'

export const prepareMigrationSchema = z.object({
  sourceId: idSchema,
  name: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, 'Use letters, numbers, spaces, hyphens or underscores.'),
  selected: z.array(z.string().min(1).max(2000)).min(1).max(80).refine(values => new Set(values).size === values.length, 'Select each change once.'),
  includeDestructive: z.boolean().default(false),
  transaction: z.enum(['caller', 'transaction']).default('caller')
}).strict()
export type PrepareMigration = z.infer<typeof prepareMigrationSchema>
export const saveMigrationSchema = z.object({ id: idSchema, reviewed: z.literal(true), destructiveApproved: z.boolean().default(false) }).strict()
export type SaveMigration = z.infer<typeof saveMigrationSchema>
export interface MigrationPreview {
  id: string; filename: string; sql: string; sha256: string; engine: DatabaseEngine;
  statements: number; destructive: boolean; warnings: string[]; expiresAt: string
}
