import type { CatalogQuery } from '../catalog/common'
import type { AdministrationChange } from '../shared/database-administration'
import { quoteIdentifier } from '../shared/sql/common'
import type { AdministrationPlan } from './reviews'

type NativePlan = AdministrationPlan & { verify(): Promise<boolean>; rebuiltIndex(): Promise<boolean> }
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"

export async function planOracleAdministration(query: CatalogQuery, change: AdministrationChange): Promise<NativePlan> {
  if (change.action !== 'analyze-table' && change.action !== 'reindex-table') {
    throw new Error('Oracle database creation, rename and removal require service or pluggable database administration.')
  }
  const { schema, table, action } = change
  const [context] = await query(`SELECT SYS_CONTEXT('USERENV','DB_UNIQUE_NAME'), SYS_CONTEXT('USERENV','CON_NAME'),
    SYS_CONTEXT('USERENV','CON_ID'), SYS_CONTEXT('USERENV','SERVICE_NAME'), SYS_CONTEXT('USERENV','SESSION_USER') FROM dual`)
  const [nativeDatabase, container, containerId, service, observer] = context ?? []
  if (!nativeDatabase || !container || !containerId || !service || observer !== schema ||
    containerId === '1' || /^(?:SYS|SYSTEM|PDB\$SEED)$/i.test(schema)) {
    throw new Error('Select a table owned by the connected user in its Oracle service. System and root containers are excluded.')
  }
  const read = async () => (await query(`SELECT o.object_id, o.data_object_id, TO_CHAR(o.created,'YYYY-MM-DD HH24:MI:SS'),
    TO_CHAR(o.last_ddl_time,'YYYY-MM-DD HH24:MI:SS')
    FROM user_tables t JOIN user_objects o ON o.object_name=t.table_name AND o.object_type='TABLE' AND o.subobject_name IS NULL
    WHERE t.table_name=:1 AND t.temporary='N' AND t.partitioned='NO' AND t.nested='NO' AND t.secondary='N'
      AND t.iot_type IS NULL AND t.cluster_name IS NULL
      AND NOT EXISTS (SELECT 1 FROM user_external_tables e WHERE e.table_name=t.table_name)
      AND NOT EXISTS (SELECT 1 FROM user_mviews m WHERE m.mview_name=t.table_name)`, [table]))[0]
  const identity = await read()
  if (!identity?.[0]) throw new Error('Select an ordinary persistent table owned by the connected Oracle user.')
  const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
  const plan = (sql: string, state: unknown, notes: string[], verify: NativePlan['verify'], rebuiltIndex = async () => false): NativePlan => ({
    database: service, observer, scope: `Oracle service · ${service} / ${container}`, target, sql, notes, verify, rebuiltIndex,
    fingerprint: JSON.stringify([context, identity, state])
  })
  // Oracle can update LAST_DDL_TIME on the table when rebuilding its
  // indexes. Keep it in the preflight fingerprint and verify stable object
  // and segment identity after executing the reviewed DDL.
  const unchanged = async () => JSON.stringify((await read())?.slice(0, 3)) === JSON.stringify(identity.slice(0, 3))

  if (action === 'analyze-table') {
    const statistics = async () => (await query(`SELECT stattype_locked, TO_CHAR(last_analyzed,'YYYY-MM-DD HH24:MI:SS')
      FROM user_tab_statistics WHERE table_name=:1 AND object_type='TABLE'`, [table]))[0]
    const prior = await statistics()
    if (!prior || prior[0] !== null) throw new Error('Oracle table statistics are unavailable or locked. This workflow does not override statistics locks.')
    const ownerArg = literal(quoteIdentifier(schema)), tableArg = literal(quoteIdentifier(table))
    const preferences = async () => (await query(`SELECT SYS.DBMS_STATS.GET_PREFS('PUBLISH',:1,:2) FROM dual`,
      [quoteIdentifier(schema), quoteIdentifier(table)]))[0]?.[0]
    if (await preferences() !== 'TRUE') throw new Error('This workflow requires Oracle statistics publishing to be enabled for the selected table.')
    return plan(`BEGIN\n  SYS.DBMS_STATS.GATHER_TABLE_STATS(ownname => ${ownerArg}, tabname => ${tableArg}, cascade => FALSE, force => FALSE);\nEND;`,
      prior, ['Gathers optimizer statistics for the owned table with its Oracle preferences. Query plans can change.',
        'Oracle can commit statistics independently. The app uses a separate connection and leaves the query tab’s transaction alone.'],
      async () => await unchanged() && Boolean((await statistics())?.[1]))
  }

  const indexes = () => query(`SELECT i.index_name, o.object_id, o.data_object_id, i.index_type, i.partitioned, i.temporary,
    i.secondary, i.status, TO_CHAR(o.last_ddl_time,'YYYY-MM-DD HH24:MI:SS')
    FROM user_indexes i JOIN user_objects o ON o.object_name=i.index_name AND o.object_type='INDEX' AND o.subobject_name IS NULL
    WHERE i.table_owner=USER AND i.table_name=:1 ORDER BY i.index_name FETCH FIRST 21 ROWS ONLY`, [table])
  const prior = await indexes()
  if (!prior.length || prior.length > 20 || prior.some(row => !row[0] || !row[1] || row[3] !== 'NORMAL' || row[4] !== 'NO' ||
    row[5] !== 'N' || row[6] !== 'N' || !['VALID', 'UNUSABLE'].includes(row[7] ?? ''))) {
    throw new Error('Oracle index rebuild requires one to 20 ordinary non-partitioned B-tree indexes on the selected table.')
  }
  const statements = prior.map(([name]) => `  EXECUTE IMMEDIATE ${literal(`ALTER INDEX ${quoteIdentifier(schema)}.${quoteIdentifier(name!)} REBUILD`)};`)
  const sameIndexes = (current: Awaited<ReturnType<typeof indexes>>) => current.length === prior.length &&
    current.every((row, i) => row[0] === prior[i][0] && row[1] === prior[i][1])
  return plan(`BEGIN\n${statements.join('\n')}\nEND;`, prior,
    ['Rebuilds the listed indexes offline. Reads or writes can be blocked and the rebuild can require extra tablespace.',
      'Oracle commits each successful index rebuild. If a later index fails, earlier rebuilds can remain applied.',
      'The app uses a separate connection. The query tab cannot roll these changes back.'],
    async () => {
      const current = await indexes()
      return await unchanged() && sameIndexes(current) && current.every(row => row[7] === 'VALID')
    },
    async () => {
      const current = await indexes()
      return sameIndexes(current) && current.some((row, i) => row[2] !== prior[i][2] || prior[i][7] === 'UNUSABLE' && row[7] === 'VALID')
    })
}
