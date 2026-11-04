import { z } from 'zod'
import { idSchema } from './id-schema'
import { decodeMysqlPrincipalId, decodeOraclePrincipalId, mysqlPrincipalSchema, mysqlRelationPrivileges, oracleRelationPrivileges, relationPrivileges, sqlServerRelationPrivileges } from './principals'

const name = z.string().min(1).max(255).refine(value => !value.includes('\0'))
const roleId = z.string().regex(/^\d{1,10}$/)
const postgresChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['create', 'create-login']), name }).strict(),
  z.object({ action: z.literal('rename'), roleId, name }).strict(),
  z.object({ action: z.enum(['drop', 'enable-login', 'disable-login']), roleId }).strict(),
  z.object({ action: z.enum(['grant', 'revoke']), roleId, member: name }).strict(),
  z.object({
    action: z.enum(['grant-relation', 'revoke-relation']), roleId,
    relation: z.object({ schema: name, name }).strict(), privilege: z.enum(relationPrivileges)
  }).strict()
])

const engine = z.enum(['mysql', 'mariadb'])
const accountId = z.string().min(1).max(2048).refine(value => decodeMysqlPrincipalId(value) !== undefined)
const mysqlChangeSchema = z.discriminatedUnion('action', [
  z.object({ engine, action: z.enum(['create', 'create-login']), account: mysqlPrincipalSchema }).strict(),
  z.object({ engine, action: z.literal('rename'), roleId: accountId, account: mysqlPrincipalSchema }).strict(),
  z.object({ engine, action: z.enum(['drop', 'enable-login', 'disable-login']), roleId: accountId }).strict(),
  z.object({ engine, action: z.enum(['grant', 'revoke']), roleId: accountId, member: mysqlPrincipalSchema }).strict(),
  z.object({
    engine, action: z.enum(['grant-relation', 'revoke-relation']), roleId: accountId,
    relation: z.object({ schema: name, name }).strict(), privilege: z.enum(mysqlRelationPrivileges)
  }).strict()
])

const sqlServerTarget = { engine: z.enum(['sqlserver', 'azure-sql']), scope: z.enum(['database', 'server']) }
const sqlServerChangeSchema = z.discriminatedUnion('action', [
  z.object({ ...sqlServerTarget, action: z.enum(['create', 'create-login', 'create-user']), name }).strict(),
  z.object({ ...sqlServerTarget, action: z.literal('create-mapped-user'), name, login: name }).strict(),
  z.object({ ...sqlServerTarget, action: z.literal('rename'), roleId, name }).strict(),
  z.object({ ...sqlServerTarget, action: z.enum(['drop', 'enable-login', 'disable-login']), roleId }).strict(),
  z.object({ ...sqlServerTarget, action: z.enum(['grant', 'revoke']), roleId, member: name }).strict(),
  z.object({
    ...sqlServerTarget, action: z.enum(['grant-relation', 'deny-relation', 'revoke-relation']), roleId,
    relation: z.object({ schema: name, name }).strict(), privilege: z.enum(sqlServerRelationPrivileges)
  }).strict()
])

const oracle = z.literal('oracle')
const oracleId = z.string().min(1).max(2048).refine(value => decodeOraclePrincipalId(value) !== undefined)
const oracleChangeSchema = z.discriminatedUnion('action', [
  z.object({ engine: oracle, action: z.enum(['create', 'create-user', 'create-login']), name }).strict(),
  z.object({
    engine: oracle, action: z.enum(['drop', 'enable-login', 'disable-login', 'grant-session', 'revoke-session']), roleId: oracleId
  }).strict(),
  z.object({ engine: oracle, action: z.enum(['grant', 'revoke']), roleId: oracleId, member: name }).strict(),
  z.object({
    engine: oracle, action: z.enum(['grant-relation', 'revoke-relation']), roleId: oracleId,
    relation: z.object({ schema: name, name }).strict(), privilege: z.enum(oracleRelationPrivileges)
  }).strict()
])

export type OraclePrincipalChange = z.infer<typeof oracleChangeSchema>
export type SqlServerPrincipalChange = z.infer<typeof sqlServerChangeSchema>
export type PostgresPrincipalChange = z.infer<typeof postgresChangeSchema>
export type MysqlAccountChange = z.infer<typeof mysqlChangeSchema>
export const preparePrincipalChangeSchema = z.object({
  sessionId: idSchema, change: z.union([postgresChangeSchema, mysqlChangeSchema, sqlServerChangeSchema, oracleChangeSchema])
}).strict()
export const applyPrincipalChangeSchema = z.object({
  sessionId: idSchema, reviewId: idSchema, acknowledge: z.literal(true), acknowledgeImplicitCommit: z.literal(true).optional(),
  confirmation: z.string().max(128), newPassword: z.string().min(1).max(128).refine(value => !value.includes('\0')).optional()
}).strict()

export type PreparePrincipalChange = z.infer<typeof preparePrincipalChangeSchema>
export type ApplyPrincipalChange = z.infer<typeof applyPrincipalChangeSchema>

export interface PrincipalChangeReview {
  id: string
  database: string
  observer: string
  sql: string
  notes: string[]
  confirmation: string
  expiresAt: string
  implicitCommit: boolean
  requiresPassword: boolean
}

export interface PrincipalChangeResult {
  status: 'applied' | 'rolled-back' | 'rejected' | 'unknown'
  message: string
}
