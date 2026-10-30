import { z } from 'zod'
import { engineSchema } from './database-engines'

const name = z.string().min(1).max(255)
export const transferMappingSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(80), engine: engineSchema,
  headers: z.array(name).min(1).max(100),
  columns: z.array(z.object({ name, type: name }).strict()).min(1).max(100),
  mapping: z.array(name.nullable()).min(1).max(100)
}).strict().superRefine((value, context) => {
  const mapped = value.mapping.filter((item): item is string => item !== null)
  if (value.mapping.length !== value.headers.length || new Set(value.headers).size !== value.headers.length || new Set(mapped).size !== mapped.length || mapped.some(item => !value.columns.some(column => column.name === item))) context.addIssue({ code: 'custom', message: 'Save unique source headers and target mappings that match the reviewed columns.' })
})
export type TransferMapping = z.infer<typeof transferMappingSchema>
export function compatibleMapping(saved: TransferMapping, engine: string, headers: string[], columns: { name: string; type: string }[]) {
  return saved.engine === engine && JSON.stringify(saved.headers) === JSON.stringify(headers) && JSON.stringify(saved.columns) === JSON.stringify(columns.map(({ name, type }) => ({ name, type })))
}
