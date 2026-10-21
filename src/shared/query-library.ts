import { z } from 'zod'
// Keep this module independent of contracts to avoid initialization cycles.
const engine=z.enum(['postgres','mysql','mariadb','sqlserver','azure-sql','sqlite','oracle','duckdb'])
export const historySearchSchema=z.object({text:z.string().max(500).default(''),connection:z.string().max(255).default(''),database:z.string().max(4096).default(''),engine:engine.optional(),status:z.enum(['completed','failed','cancelled','unknown']).optional(),from:z.iso.datetime().optional(),to:z.iso.datetime().optional(),favorites:z.boolean().default(false),offset:z.number().int().min(0).max(10000).default(0),limit:z.number().int().min(1).max(100).default(50)}).strict()
export type HistorySearch=z.input<typeof historySearchSchema>
export const historySettingsSchema=z.object({enabled:z.boolean(),maxEntries:z.number().int().min(1).max(10000),maxAgeDays:z.number().int().min(0).max(3650),keepFavorites:z.boolean()}).strict()
export type HistorySettings=z.infer<typeof historySettingsSchema>
export const DEFAULT_HISTORY_SETTINGS:HistorySettings={enabled:true,maxEntries:500,maxAgeDays:0,keepFavorites:true}
export const snippetSchema=z.object({id:z.string().uuid().optional(),name:z.string().trim().min(1).max(100),description:z.string().max(1000),engine:engine.optional(),sql:z.string().trim().min(1).max(100000),favorite:z.boolean()}).strict()
export type SnippetInput=z.infer<typeof snippetSchema>
export type Snippet=SnippetInput&{id:string;createdAt:string;updatedAt:string}
export const snippetSearchSchema=z.object({text:z.string().max(500).default(''),engine:engine.optional(),favorites:z.boolean().default(false)}).strict()
