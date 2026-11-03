import { z } from 'zod'
import { idSchema, type DatabaseEngine } from './contracts'
import { orderMigrationDrops } from './migration-order'
import { objectKinds, type ObjectDetail, type CatalogObject } from './catalog'

export const SCHEMA_INVENTORY_LIMIT = 1000
export const SCHEMA_DETAIL_LIMIT = 40
const compareScopeSchema = z.object({ sessionId: idSchema, schema: z.string().min(1).max(255), catalog: z.string().max(255).optional() }).strict()
export const compareSchemaSchema = z.object({
  source: compareScopeSchema,
  target: compareScopeSchema,
  filter: z.string().max(200).refine(value => !value.includes('\0'), 'The filter cannot contain NUL.').default(''),
  kinds: z.array(z.enum(objectKinds)).min(1).max(objectKinds.length).default(['table', 'view']),
  mode: z.enum(['inventory', 'definitions']).optional(),
  selection: z.array(z.string().min(1).max(2000)).min(1).max(SCHEMA_DETAIL_LIMIT)
    .refine(values => new Set(values).size === values.length, 'Select each object once.').optional()
}).strict().refine(value => value.mode !== 'inventory' || !value.selection, 'Select definitions after comparing the inventory.')
export type CompareScope = z.infer<typeof compareScopeSchema>
export type CompareSchemaRequest = z.infer<typeof compareSchemaSchema>
export interface ComparedObject {
  key: string; name: string; kind: CatalogObject['kind']; parent?: string; signature?: string;
  status: 'source-only' | 'target-only' | 'changed' | 'matching' | 'unknown' | 'unchecked';
  requiredDrops?: { key: string; name: string }[];
  source?: ObjectDetail; target?: ObjectDetail; notices: string[]; sql: string[]; destructiveSql: string[]
}
export interface SchemaComparison {
  migrationSourceId?: string;
  mode?: CompareSchemaRequest['mode'];
  engine: DatabaseEngine; source: CompareScope; target: CompareScope; sourceLabel: string; targetLabel: string;
  objects: ComparedObject[]; notices: string[]; fetchedAt: string
}
// Every line is commented separately: definitions and identifiers are untrusted SQL text.
export const sqlComment = (text: string) => text.split(/\r\n|[\r\n\u2028\u2029]/).map(line => `-- ${line}`).join('\n')
export function comparisonSql(result: SchemaComparison, selected: string[], destructive = false) {
  const parts = [sqlComment(`Schema comparison: ${result.sourceLabel} → ${result.targetLabel}\nCaptured ${result.fetchedAt}. Refresh and review the target before executing.\nPartial suggestions, not a complete migration. No SQL has been executed.\n${['mysql','mariadb','oracle'].includes(result.engine) ? 'DDL commits implicitly; changes cannot be rolled back.' : 'Review transaction boundaries before executing; no COMMIT is added.'}\n${result.notices.join('\n')}`)]
  const included = new Set(selected)
  const items = result.objects.filter(item => included.has(item.key) && item.status !== 'matching')
  let drops: ComparedObject[] = []
  if (destructive) {
    try { drops = orderMigrationDrops(items.filter(item => item.destructiveSql.length)) }
    catch (error) { parts.push(sqlComment((error as Error).message)) }
  }
  const executableDrops = new Set(drops.map(item => item.key))
  for (const item of items) {
    parts.push(sqlComment(`${item.status}: ${item.kind} ${item.name}${item.parent ? ` on ${item.parent}` : ''}\n${item.notices.join('\n')}`))
    parts.push(...item.sql)
    if (!executableDrops.has(item.key)) {
      parts.push(...item.destructiveSql.map(sql => sqlComment(`Destructive suggestion (excluded):\n${sql}`)))
    }
    if (item.source?.definition.sql) parts.push(sqlComment(`Source definition (${item.source.definition.source}; reference only, original namespace):\n${item.source.definition.notice ?? ''}\n${item.source.definition.sql}`))
    if (item.target?.definition.sql) parts.push(sqlComment(`Target definition (${item.target.definition.source}; reference only):\n${item.target.definition.notice ?? ''}\n${item.target.definition.sql}`))
  }
  for (const item of drops) parts.push(sqlComment(`Drop ${item.name} in captured foreign-key order.`), ...item.destructiveSql)
  return parts.join('\n\n') + '\n'
}
