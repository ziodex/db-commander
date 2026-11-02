import { expect } from 'vitest'
import type { DriverRegistry } from '../../src/driver/registry'
import { objectKey } from '../../src/shared/catalog'

/** Runs inside each existing isolated real-engine catalog fixture. */
export async function verifyCatalogNavigation(driver: DriverRegistry, sessionId: string, table: string, prefix: string,
  q: (name: string) => string, run: (sql: string) => Promise<unknown>, drops: string[]) {
  const view = (index: number) => prefix + '_page_' + String(index).padStart(3, '0')
  for (let i = 0; i < 105; i++) {
    await run(`CREATE VIEW ${q(view(i))} AS SELECT ${q('id')} FROM ${q(table)}`)
    drops.unshift(`DROP VIEW ${q(view(i))}`)
  }
  const read = { sessionId, search: prefix + '_page_', kind: 'view' as const, rootsOnly: false }
  const first = await driver.catalogPage(read)
  expect(first.objects).toHaveLength(100); expect(first.previous).toBeUndefined()
  const last = await driver.catalogPage({ ...read, cursor: { direction: 'after', object: first.next! } })
  expect(last.objects).toHaveLength(5); expect(last.next).toBeUndefined()
  expect(new Set([...first.objects, ...last.objects].map(objectKey)).size).toBe(105)
  const previous = await driver.catalogPage({ ...read, cursor: { direction: 'before', object: last.previous! } })
  expect(previous.objects).toEqual(first.objects); expect(previous.previous).toBeUndefined()
  const detail = await driver.inspectObject({ sessionId, object: last.objects.at(-1)! })
  expect(detail.definition.sql).toContain(view(104))
  await expect(driver.inspectObject({ sessionId, object: { ...last.objects[0], identity: 'missing-object-identity' } })).rejects.toThrow(/no longer visible/)
  const literal = prefix + "%_!['quoted"
  await run(`CREATE VIEW ${q(literal)} AS SELECT ${q('id')} FROM ${q(table)}`)
  drops.unshift(`DROP VIEW ${q(literal)}`)
  const result = await driver.catalogPage({ ...read, search: "%_!['quoted" })
  expect(result.objects.map(o => o.name)).toEqual([literal])
  expect((await driver.catalogPage({ ...read, search: view(104), kind: 'table' })).objects).toEqual([])
}
