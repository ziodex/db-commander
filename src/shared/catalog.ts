import { z } from 'zod'
import { idSchema, type Cell } from './contracts'

export const objectKinds = ['table', 'view', 'materialized view', 'index', 'constraint', 'function', 'procedure', 'trigger', 'sequence', 'macro', 'package', 'type'] as const
export const constraintKinds = ['primary key', 'foreign key', 'unique', 'check', 'default', 'not null', 'other'] as const
export const catalogObjectSchema = z.object({ catalog: z.string().max(255).optional(), schema: z.string().min(1).max(255), name: z.string().min(1).max(255), kind: z.enum(objectKinds), identity: z.string().max(1024), parent: z.string().max(255).optional(), signature: z.string().max(2048).optional(), constraintType: z.enum(constraintKinds).optional() }).strict()
export type CatalogObject = z.infer<typeof catalogObjectSchema>
export const inspectObjectSchema = z.object({ sessionId: idSchema, object: catalogObjectSchema }).strict()
export type InspectObjectRequest = z.infer<typeof inspectObjectSchema>
export interface CatalogSnapshot { objects: CatalogObject[]; truncated: boolean; notice: string }
export interface CatalogSection { title: string; columns: string[]; rows: Cell[][]; truncated?: boolean }
export interface ObjectDetail { object: CatalogObject; sections: CatalogSection[]; definition: { sql: string | null; source: 'native' | 'generated' | 'unavailable'; notice?: string; truncated?: boolean }; fetchedAt: string; source: 'catalog-connection' | 'session' }
export interface CatalogResponse { diagram?: import('./diagram').DiagramSnapshot; catalog?: CatalogSnapshot; detail?: ObjectDetail }
export function objectKey(object: CatalogObject) { return JSON.stringify([object.catalog ?? '', object.schema, object.kind, object.name, object.identity, object.parent ?? '']) }
