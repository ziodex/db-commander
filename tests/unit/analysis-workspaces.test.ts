import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqlFiles } from '../../src/files/sql-files'
import { DEFAULT_PROFILE, type DatabaseEngine, type SessionInfo } from '../../src/shared/contracts'
import { diagramLayoutScope, diagramLayoutsSchema, layoutHasTables, recoverDiagramLayouts, resolveLayoutTables, type SavedDiagramLayout } from '../../src/shared/diagram-layouts'
import { planFormat, type ExplainResult, type PlanOutput } from '../../src/shared/explain'
import { comparePlanOperators, explainTree } from '../../src/shared/plan-tree'
import { openSqlFileSchema } from '../../src/shared/sql-files'

const session: SessionInfo = { id: randomUUID(), engine: 'postgres', name: 'Local', database: 'test', user: 'analyst', host: 'localhost', port: 5432, tls: true, transaction: 'idle', version: '' }
function capture(engine: DatabaseEngine, raw: string, output: PlanOutput = { columns: [], rows: [] }): ExplainResult {
  return { engine, raw, output, mode: 'estimated', sql: 'SELECT * FROM sales', submittedSql: [], status: 'completed',
    durationMs: 2, session: { ...session, engine }, source: 'session', format: planFormat(engine), message: '', capturedAt: new Date().toISOString() }
}

describe('visual plans', () => {
  it('renders DuckDB physical operators and preserves native estimate units', () => {
    const output = { columns: ['explain_key', 'explain_value'], rows: [['physical_plan', '']] }
    const raw = JSON.stringify([{ name: 'HASH_JOIN', children: [{ name: 'SEQ_SCAN', children: [], extra_info: { Table: 'sales', 'Estimated Cardinality': '42' } }], extra_info: {} }])
    const tree = explainTree(capture('duckdb', raw, output))
    expect(tree.notice).toBeUndefined()
    expect(tree.nodes).toMatchObject([{ type: 'HASH_JOIN', depth: 0 }, { parent: 0, depth: 1, type: 'SEQ_SCAN', relation: 'sales', estimatedRows: 42 }])
    expect(tree.nodes[1].cost).toBeUndefined()
  })

  it('shows MySQL and MariaDB join structure and native scan estimates', () => {
    const raw = JSON.stringify({ query_block: { cost_info: { query_cost: '1.25' }, nested_loop: [
      { table: { table_name: 'sales', access_type: 'ALL', rows_examined_per_scan: 14 } },
      { table: { table_name: 'items', access_type: 'ref', rows: 3 } }
    ] } })
    for (const engine of ['mysql', 'mariadb'] as const) {
      const tree = explainTree(capture(engine, raw))
      expect(tree.nodes).toMatchObject([{ type: 'Query block', cost: 1.25 }, { type: 'Nested loop', parent: 0 },
        { type: 'Table access · ALL', parent: 1, relation: 'sales', estimatedRows: 14 }, { parent: 1, relation: 'items', estimatedRows: 3 }])
      expect(tree.notice).toContain('recognized')
    }
  })

  it('reads native parent identities and rejects orphaned or cyclic table plans', () => {
    const columns = ['id', 'parent', 'notused', 'detail']
    const sqlite = explainTree(capture('sqlite', 'plan', { columns, rows: [['7', '8', '0', 'SCAN sales'], ['8', '0', '0', 'MATERIALIZE x']] }))
    expect(sqlite.nodes).toMatchObject([{ type: 'MATERIALIZE x' }, { type: 'SCAN sales', parent: 0 }])
    const oracle = explainTree(capture('oracle', 'native text', { columns: [], rows: [], oracleOperators: [
      ['0', null, '1', 'SELECT STATEMENT', null, null, null, '1', '4', '10'],
      ['1', '0', '1', 'TABLE ACCESS', 'FULL', 'DEMO', 'SALES', '1', '4', '10']
    ] }))
    expect(oracle.nodes[1]).toMatchObject({ type: 'TABLE ACCESS FULL', relation: 'DEMO.SALES', parent: 0, cost: 4, estimatedRows: 1 })
    expect(() => explainTree(capture('sqlite', 'plan', { columns, rows: [['1', '2', '0', 'x'], ['2', '1', '0', 'y']] }))).toThrow('Raw plan')
  })

  it('compares operator counts without treating equal counts as equal raw plans', () => {
    const columns = ['id', 'parent', 'notused', 'detail']
    const tree = (operation: string) => explainTree(capture('sqlite', operation, { columns, rows: [['2', '0', '0', operation]] }))
    expect(comparePlanOperators(tree('SCAN sales'), tree('SEARCH sales USING INDEX sales_idx'))).toEqual([
      expect.objectContaining({ type: 'SCAN sales', before: 1, after: 0 }),
      expect.objectContaining({ type: 'SEARCH sales USING INDEX sales_idx', before: 0, after: 1 })
    ])
    expect(comparePlanOperators(tree('SCAN sales'), tree('SCAN sales'))).toEqual([])
  })
})

describe('saved diagram layouts', () => {
  const object = { schema: 'public', name: 'sales', kind: 'table', identity: '42' } as const
  const table = { schema: 'public', name: 'sales' }
  const layout: SavedDiagramLayout = { name: 'Sales overview', scope: diagramLayoutScope(DEFAULT_PROFILE, session)!,
    tables: [{ table, position: { x: 20, y: 80 } }], showColumns: false, zoom: .85 }

  it('binds a layout to a database and resolves fresh table identities after reconnecting', () => {
    expect(diagramLayoutsSchema.parse([layout])).toEqual([layout])
    expect(diagramLayoutScope(DEFAULT_PROFILE, { ...session, database: 'another' })).not.toBe(layout.scope)
    expect(layoutHasTables(layout, [object])).toBe(true)
    const fresh = { ...object, identity: '43' }
    expect(resolveLayoutTables(layout, [fresh])).toEqual([fresh])
    expect(() => resolveLayoutTables(layout, [])).toThrow('unavailable')
    expect(() => resolveLayoutTables(layout, [object, fresh])).toThrow('unavailable')
    expect(diagramLayoutScope({ ...DEFAULT_PROFILE, engine: 'sqlite', sqliteMode: 'memory' }, { ...session, engine: 'sqlite', host: ':memory:' })).toBeUndefined()
  })

  it('keeps valid records when disk presentation metadata is malformed', () => {
    expect(diagramLayoutsSchema.safeParse([layout, layout]).success).toBe(false)
    expect(recoverDiagramLayouts([layout, { ...layout, tables: [{ table, position: { x: -5, y: 80 } }] }, { sql: 'SELECT 1' }])).toEqual([layout])
  })
})

describe('SQL projects', () => {
  it('persists only folder authority, refreshes checkout entries and reuses file conflict handling', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbcommander-project-'))
    const root = join(directory, 'checkout'), sql = join(root, 'migrations', '01.sql')
    const path = join(directory, 'sql-files.json')
    try {
      await mkdir(join(root, 'migrations'), { recursive: true })
      await mkdir(join(root, '.git'))
      await writeFile(sql, 'SELECT 1;\n')
      await writeFile(join(root, 'readme.txt'), 'not SQL')
      await writeFile(join(root, '.git', 'hidden.sql'), 'hidden')
      const files = new SqlFiles(path)
      const project = await files.chooseProject(root)
      expect(project.files.map(entry => entry.relativePath)).toEqual(['migrations/01.sql'])
      const tabId = randomUUID()
      const opened = await files.openProjectFile(tabId, project.files[0].id)
      expect(opened.sql).toBe('SELECT 1;\n')
      await writeFile(sql, 'SELECT 2;\n')
      expect(await files.save(tabId, 'SELECT 3;\n')).toHaveProperty('conflict')
      const reopened = new SqlFiles(path)
      await reopened.load()
      const fresh = (await reopened.listProject())!
      await expect(reopened.openProjectFile(randomUUID(), project.files[0].id)).rejects.toThrow('no longer listed')
      expect((await reopened.openProjectFile(randomUUID(), fresh.files[0].id)).file.tabId).toBe(tabId)
      await reopened.closeProject()
      expect(await reopened.listProject()).toBeNull()
      expect(reopened.document(tabId)).toBeDefined()
      expect(openSqlFileSchema.safeParse({ tabId, projectEntryId: randomUUID(), path: sql }).success).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('refuses a replaced parent directory or replacement project root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbcommander-project-replaced-'))
    const root = join(directory, 'project'), child = join(root, 'queries'), outside = join(directory, 'outside')
    try {
      await mkdir(child, { recursive: true }); await mkdir(outside)
      await writeFile(join(child, 'query.sql'), 'SELECT 1')
      await writeFile(join(outside, 'query.sql'), 'SELECT 2')
      const files = new SqlFiles(join(directory, 'files.json')), project = await files.chooseProject(root)
      await rename(child, join(root, 'moved'))
      await symlink(outside, child, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(files.openProjectFile(randomUUID(), project.files[0].id)).rejects.toThrow('symbolic link')
      await rename(root, join(directory, 'previous-root'))
      await mkdir(root)
      await expect(files.listProject()).rejects.toThrow('folder changed')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
