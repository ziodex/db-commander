import { z } from 'zod'
import { idSchema } from './id-schema'
import { quoteIdentifier } from './sql/common'

export const PRINCIPAL_LIMIT = 100
const nameSchema = z.string().min(1).max(255).refine(value => !value.includes('\0'))
const principalScopeSchema = z.enum(['database', 'server'])
export type PrincipalScope = z.infer<typeof principalScopeSchema>
const relationSchema = z.object({ schema: nameSchema, name: nameSchema }).strict()
export const principalRequestSchema = z.discriminatedUnion('mode', [
  z.object({ sessionId: idSchema, mode: z.literal('roles'), scope: principalScopeSchema.optional(), search: z.string().max(255) }).strict(),
  z.object({ sessionId: idSchema, mode: z.literal('role'), scope: principalScopeSchema.optional(), roleId: z.string().min(1).max(2048).refine(value => /^\d{1,10}$/.test(value) || decodeMysqlPrincipalId(value) !== undefined || decodeOraclePrincipalId(value) !== undefined), relation: relationSchema.optional() }).strict()
])
export type PrincipalRequest = z.infer<typeof principalRequestSchema>
export type PrincipalRelation = z.infer<typeof relationSchema>

export interface PrincipalRole {
  id: string
  name: string
  account?: MysqlPrincipal
  description?: string
  canGrantMembership?: boolean
  login?: boolean
  superuser?: boolean
  inherit?: boolean
  createRole?: boolean
  createDatabase?: boolean
  replication?: boolean
  bypassRls?: boolean
}
export interface Bounded<T> { rows: T[]; truncated: boolean }
export interface PrincipalPrivilege { privilege: string; effective: boolean; grantable: boolean }
export interface PrincipalMembership {
  role: string
  member: string
  grantor: string | null
  admin: boolean | null
  inherit: boolean | null
  set: boolean | null
}
export type PrincipalSnapshot = { database: string; observer: string; notice?: string } & (
  { mode: 'roles'; roles: Bounded<PrincipalRole> } |
  { mode: 'role'; role: PrincipalRole; direct: Bounded<PrincipalMembership>; memberships: Bounded<{ role: string; usable: boolean | null }>;
    databasePrivileges: PrincipalPrivilege[]
    catalog?: {
      grants: Bounded<PrincipalCatalogGrant>
      enabled: Bounded<string> | null
      effective?: Bounded<{ scope: string; privilege: string }>
      grantNotice?: string
      membershipNotice?: string
      enabledLabel?: string
      relation?: PrincipalRelation | null
    }
    relation?: { target: PrincipalRelation; schemaUsage: boolean; rowSecurity: boolean; owner: string; privileges: PrincipalPrivilege[];
      grants: Bounded<{ grantee: string; grantor: string; privilege: string; grantable: boolean }> } | null }
)

export const relationPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const
export type RelationPrivilege = typeof relationPrivileges[number]

export type PrincipalChange =
  | { action: 'create'; name: string }
  | { action: 'grant' | 'revoke'; role: string; member: string }
  | { action: 'grant-relation' | 'revoke-relation'; role: string; relation: PrincipalRelation; privilege: RelationPrivilege }

function checkedRoleName(name: string) {
  if (!nameSchema.safeParse(name).success || !name.trim() || new TextEncoder().encode(name).length > 63) {
    throw new Error('Enter a role name between 1 and 63 UTF-8 bytes.')
  }
  return name
}

export function previewPrincipalChange(change: PrincipalChange): string {
  if (change.action === 'create') {
    const name = checkedRoleName(change.name)
    if (/^pg_|^public$|^none$/i.test(name)) throw new Error('Choose a name outside PostgreSQL’s reserved role names.')
    return `CREATE ROLE ${quoteIdentifier(name)} NOLOGIN;`
  }
  const role = quoteIdentifier(nameSchema.parse(change.role))
  if ('relation' in change) {
    const target = relationSchema.parse(change.relation), privilege = z.enum(relationPrivileges).parse(change.privilege)
    const qualified = `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.name)}`
    return change.action === 'grant-relation' ? `GRANT ${privilege} ON TABLE ${qualified} TO ${role};`
      : `REVOKE ${privilege} ON TABLE ${qualified} FROM ${role} RESTRICT;`
  }
  const member = quoteIdentifier(checkedRoleName(change.member))
  if (role === member) throw new Error('Choose two different roles.')
  return change.action === 'grant' ? `GRANT ${role} TO ${member};` : `REVOKE ${role} FROM ${member} RESTRICT;`
}

export interface PrincipalCatalogGrant {
  scope: string
  privilege: string
  grantable: boolean | null
  via?: string
  effect?: string
  enabled?: boolean
}

const accountNameSchema = z.string().max(128).refine(value => !value.includes('\0'))
const accountHostSchema = z.string().max(255).refine(value => !value.includes('\0'))
export const mysqlPrincipalSchema = z.object({ user: accountNameSchema, host: accountHostSchema }).strict()
export type MysqlPrincipal = z.infer<typeof mysqlPrincipalSchema>
export function decodeMysqlPrincipalId(value: string): MysqlPrincipal | undefined {
  try {
    const tuple: unknown = JSON.parse(value)
    if (!Array.isArray(tuple) || tuple.length !== 2) return
    const result = mysqlPrincipalSchema.safeParse({ user: tuple[0], host: tuple[1] })
    return result.success ? result.data : undefined
  } catch { return undefined }
}
export type MysqlPrincipalEngine = 'mysql' | 'mariadb'
export const mysqlRelationPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'ALTER', 'INDEX', 'TRIGGER', 'SHOW VIEW', 'CREATE VIEW', 'DROP'] as const
export type MysqlPrincipalChange =
  | { action: 'create'; role: MysqlPrincipal }
  | { action: 'grant' | 'revoke'; role: MysqlPrincipal; member: MysqlPrincipal }
  | { action: 'grant-relation' | 'revoke-relation'; role: MysqlPrincipal; relation: PrincipalRelation; privilege: string }

export function mysqlPrincipalSql(engine: MysqlPrincipalEngine, input: MysqlPrincipal): string {
  const { user, host } = mysqlPrincipalSchema.parse(input)
  if (engine === 'mariadb' && !host) {
    if (!user) throw new Error('Enter an exact MariaDB role name.')
    return quoteIdentifier(user, engine)
  }
  if (!host) throw new Error('Enter the exact account host.')
  return quoteIdentifier(user, engine) + '@' + quoteIdentifier(host, engine)
}

export function previewMysqlPrincipalChange(engine: MysqlPrincipalEngine, change: MysqlPrincipalChange): string {
  const role = mysqlPrincipalSql(engine, change.role)
  if (change.action === 'create') {
    const limit = engine === 'mysql' ? 32 : 128
    if (!change.role.user.trim() || Array.from(change.role.user).length > limit || engine === 'mariadb' && change.role.host) {
      throw new Error('Enter a valid role name for this engine.')
    }
    return `CREATE ROLE ${role};`
  }
  if ('relation' in change) {
    const target = relationSchema.parse(change.relation), privilege = z.enum(mysqlRelationPrivileges).parse(change.privilege)
    const qualified = quoteIdentifier(target.schema, engine) + '.' + quoteIdentifier(target.name, engine)
    return change.action === 'grant-relation' ? `GRANT ${privilege} ON ${qualified} TO ${role};`
      : `REVOKE ${privilege} ON ${qualified} FROM ${role};`
  }
  if (engine === 'mariadb' && change.role.host) throw new Error('Select a MariaDB role to change its membership.')
  const member = mysqlPrincipalSql(engine, change.member)
  if (role === member || !change.member.user) throw new Error('Choose a different, named member.')
  return change.action === 'grant' ? `GRANT ${role} TO ${member};` : `REVOKE ${role} FROM ${member};`
}

export const sqlServerRelationPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'ALTER', 'CONTROL', 'VIEW DEFINITION'] as const
export type NamedPrincipalChange =
  | { action: 'create'; name: string }
  | { action: 'grant' | 'revoke'; role: string; member: string }
  | { action: 'grant-relation' | 'revoke-relation'; role: string; relation: PrincipalRelation; privilege: string }

export function previewSqlServerPrincipalChange(engine: 'sqlserver' | 'azure-sql', scope: PrincipalScope, change: NamedPrincipalChange): string {
  const name = (value: string) => {
    if (!nameSchema.safeParse(value).success || !value.trim() || value.length > 128) throw new Error('Enter an exact principal name of 1 to 128 characters.')
    return quoteIdentifier(value, engine)
  }
  const roleKind = scope === 'server' ? 'SERVER ROLE' : 'ROLE'
  if (change.action === 'create') {
    if (scope === 'server' && engine === 'azure-sql') throw new Error('Azure SQL uses predefined server roles.')
    return `CREATE ${roleKind} ${name(change.name)};`
  }
  const role = name(change.role)
  if ('relation' in change) {
    if (scope !== 'database') throw new Error('Select a database principal for relation privileges.')
    const target = relationSchema.parse(change.relation), privilege = z.enum(sqlServerRelationPrivileges).parse(change.privilege)
    const qualified = name(target.schema) + '.' + name(target.name)
    return change.action === 'grant-relation' ? `GRANT ${privilege} ON OBJECT::${qualified} TO ${role};`
      : `REVOKE ${privilege} ON OBJECT::${qualified} FROM ${role};`
  }
  const member = name(change.member)
  if (role === member) throw new Error('Choose two different principals.')
  return `ALTER ${roleKind} ${role} ${change.action === 'grant' ? 'ADD' : 'DROP'} MEMBER ${member};`
}

const oraclePrincipalKey = z.tuple([z.literal('oracle'), nameSchema, z.enum(['user', 'role'])])
export function decodeOraclePrincipalId(value: string) {
  try {
    const result = oraclePrincipalKey.safeParse(JSON.parse(value))
    return result.success ? { name: result.data[1], kind: result.data[2] } : undefined
  } catch { return undefined }
}

export const oracleRelationPrivileges = ['SELECT', 'READ', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES'] as const
export function quoteOraclePrincipal(value: string) {
  if (!nameSchema.safeParse(value).success || !value.trim() || value.includes('"') || new TextEncoder().encode(value).length > 128) {
    throw new Error('Enter an exact Oracle identifier of 1 to 128 bytes without double quotes.')
  }
  return quoteIdentifier(value, 'oracle')
}

export function previewOraclePrincipalChange(change: NamedPrincipalChange): string {
  const name = quoteOraclePrincipal
  if (change.action === 'create') return `CREATE ROLE ${name(change.name)} NOT IDENTIFIED;`
  const role = name(change.role)
  if ('relation' in change) {
    const target = relationSchema.parse(change.relation), privilege = z.enum(oracleRelationPrivileges).parse(change.privilege)
    const qualified = name(target.schema) + '.' + name(target.name)
    return change.action === 'grant-relation' ? `GRANT ${privilege} ON ${qualified} TO ${role};`
      : `REVOKE ${privilege} ON ${qualified} FROM ${role};`
  }
  const member = name(change.member)
  if (role === member) throw new Error('Choose two different principals.')
  return change.action === 'grant' ? `GRANT ${role} TO ${member};` : `REVOKE ${role} FROM ${member};`
}
