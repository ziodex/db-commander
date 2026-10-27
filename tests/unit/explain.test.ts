import { expect, it } from 'vitest'
import { explainRequestSchema, postgresPlan } from '../../src/shared/explain'
import { explainSql, explainStatement } from '../../src/explain/sql'
import { PlanCollector, rawPlan } from '../../src/explain/execution'
import type { ConnectionConfig } from '../../src/shared/contracts'

it('distinguishes estimate/analyze commands and rejects renderer-supplied execution options', () => {
  expect(explainRequestSchema.safeParse({ sessionId: 'not-a-session', sql: 'SELECT 1', mode: 'estimated' }).success).toBe(false)
  expect(explainRequestSchema.safeParse({ sessionId: '9c559c46-7cb2-44c4-b110-2aca13e58b9b', sql: 'SELECT 1', mode: 'estimated', commands: ['SET SHOWPLAN_XML OFF'] }).success).toBe(false)
  expect(explainStatement('SELECT 1', 'postgres', 'estimated')).not.toContain('ANALYZE')
  expect(explainStatement('SELECT 1', 'postgres', 'analyze')).toContain('ANALYZE, BUFFERS')
  expect(() => explainStatement('SELECT 1', 'mysql', 'analyze')).toThrow(/only for PostgreSQL/)
})
it('accepts one statement with native quoted text and refuses scripts or nested explain commands', () => {
  for (const engine of ['postgres','mysql','mariadb','sqlite','oracle','duckdb','sqlserver','azure-sql'] as const) {
    expect(explainSql("-- selected\nSELECT ';' AS value; -- trailing", engine)).toBe("-- selected\nSELECT ';' AS value")
    for (const sql of ['SELECT 1; DELETE FROM secrets', 'EXPLAIN ANALYZE SELECT 1', "SELECT 'unterminated", 'SELECT 1 /* unfinished']) expect(() => explainSql(sql, engine)).toThrow()
  }
  expect(explainSql("SELECT $$; DELETE FROM secrets$$", 'postgres')).toContain('$$')
  expect(explainSql("SELECT q'[; DELETE FROM secrets]' FROM dual", 'oracle')).toContain('dual')
  expect(explainSql('SELECT CASE WHEN 1=1 THEN 2 ELSE 3 END AS answer', 'sqlserver')).toContain('CASE')
  for (const sql of ['SELECT 1 /*!; DROP TABLE a */', 'SELECT 1 /*M! ANALYZE */', "SELECT 'a\\'; DELETE FROM t; --'"]) expect(() => explainSql(sql, 'mysql')).toThrow()
  for (const sql of ['SELECT 1\nSET SHOWPLAN_XML OFF\nDELETE FROM t', 'SELECT 1\nGO\nSELECT 2', 'SELECT 1 EXEC sp_executesql N\'DELETE FROM t\'']) expect(() => explainSql(sql,'sqlserver')).toThrow()
})
it('extracts PostgreSQL nodes without inventing exclusive timing or multiplying per-loop rows', () => {
  const raw = JSON.stringify([{ Plan: { 'Node Type': 'Nested Loop', 'Total Cost': 20, Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': '<img onerror=alert(1)>', 'Plan Rows': 2, 'Actual Rows': 3, 'Actual Loops': 4, 'Actual Total Time': 0.1, 'Index Cond': '(id = 1)' }] }, 'Planning Time': 1.1, 'Execution Time': 2.2 }])
  const plan = postgresPlan(raw)
  expect(plan.nodes[1]).toMatchObject({ parent: 0, depth: 1, estimatedRows: 2, actualRows: 3, loops: 4, time: 0.1 })
  expect(plan.executionTime).toBe(2.2); expect(plan.nodes[1].details['Index Cond']).toBe('(id = 1)')
  expect(() => postgresPlan('{}')).toThrow(/Unrecognized/)
  expect(() => postgresPlan('[{"Plan":{"Node Type":"Root","Plans":{}}}]')).toThrow(/child/)
  const root: any = { 'Node Type': 'Root' }; let current = root
  for (let i = 0; i < 110; i++) { current.Plans = [{ 'Node Type': 'Deep' }]; current = current.Plans[0] }
  expect(postgresPlan(JSON.stringify([{ Plan: root }])).notice).toContain('limited')
})
it('refuses oversized plans instead of presenting partial output as complete', () => {
  const collector = new PlanCollector()
  expect(() => collector.row(['x'.repeat(1_000_001)])).toThrow(/capture limit/)
  for (let i = 0; i < 2000; i++) collector.row(['ok'])
  expect(() => collector.row(['overflow'])).toThrow(/capture limit/)
})
it('rejects absent or non-plan output instead of showing a completed SQL Server plan', () => {
  const config = { engine: 'sqlserver' } as ConnectionConfig
  for (const rows of [[], [['']], [['42']]]) expect(() => rawPlan(config, { columns: [], rows })).toThrow(/execution plan/)
  expect(rawPlan(config, { columns: ['XML'], rows: [['<ShowPlanXML Version="1"><BatchSequence /></ShowPlanXML>']] })).toContain('ShowPlanXML')
})
it('validates parameterized plan requests without accepting internal execution fields', () => {
  const request = { sessionId: '9c559c46-7cb2-44c4-b110-2aca13e58b9b', sql: 'SELECT :id', mode: 'estimated', parameters: [{ name: 'id', type: 'integer', value: '9223372036854775807' }] }
  expect(explainRequestSchema.parse(request).parameters).toEqual(request.parameters)
  for (const extra of [{ bound: { sql: 'DELETE FROM t', values: [] } }, { fullExport: true }, { commands: ['SET SHOWPLAN_XML OFF'] }]) expect(explainRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false)
  expect(explainRequestSchema.safeParse({ ...request, parameters: [{ ...request.parameters[0], value: '9223372036854775808' }] }).success).toBe(false)
  for (const engine of ['postgres','mysql','mariadb','sqlite','oracle','duckdb','sqlserver','azure-sql'] as const) {
    expect(explainSql('SELECT :analyze, :update, :go', engine)).toBe('SELECT :analyze, :update, :go')
    expect(() => explainSql('SELECT :id; DELETE FROM t', engine)).toThrow(/one statement/)
  }
  expect(explainSql(String.raw`SELECT '\', :id`, 'mysql', true, true)).toContain(':id')
})
