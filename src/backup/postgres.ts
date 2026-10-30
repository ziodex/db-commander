import pg from 'pg'
import { isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import { endpoint } from '../connections/transport'
import type { ConnectionConfig } from '../shared/contracts'

export async function openBackupPostgres(config: ConnectionConfig, queryTimeout?: number) {
  const client = new pg.Client({ ...endpoint(config), user: config.user, password: config.password, database: config.database, connectionTimeoutMillis: 15000, ...(queryTimeout ? { query_timeout: queryTimeout } : {}),
    ssl: config.tls === 'verify-full' ? { rejectUnauthorized: true, ...(isIP(config.host) ? {} : { servername: config.host }), checkServerIdentity: (_host, cert) => checkServerIdentity(config.host, cert), ...(config.ca ? { ca: config.ca } : {}) } : false })
  client.on('error', () => {})
  try { await client.connect(); return client }
  catch (error) { await client.end().catch(() => {}); throw error }
}
