import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseJsonLines } from '../../src/transfer/jsonl'
import { inspectDataFile } from '../../src/transfer/preview'
import { inferImportColumns } from '../../src/shared/import-inference'
import { compatibleMapping, transferMappingSchema } from '../../src/shared/transfer-mappings'
import { WorkspaceStore } from '../../src/storage/store'

async function records(data: string, width = 1) {
  async function* chunks() { for (let i = 0; i < data.length; i += width) yield data.slice(i, i + width) }
  const rows = []; for await (const row of parseJsonLines(chunks())) rows.push(row); return rows
}
it('streams exact JSON Lines records across UTF-16 chunks, including null, empty text and escaped newlines', async () => {
  const rows = [['9223372036854775807', null, ''], ['001', 'quote"\nΩ😀', '9007199254740993.12345678']]
  const data = '\uFEFF' + JSON.stringify({ columns: ['id','label','amount'].map(name => ({ name, typeId: 0 })) }) + '\r\n\n' + rows.map(row => JSON.stringify(row)).join('\r\n')
  for (const width of [1, 2, 31, 65536]) expect(await records(data, width)).toEqual([['id','label','amount'], ...rows])
})
it.each([
  '', '{"columns":[{"name":"a","typeId":0}]}\n[1]', '{"columns":[{"name":"a","typeId":0}]}\n[true]', '{"columns":[{"name":"a","typeId":0}]}\n[{}]',
  '{"columns":[{"name":"a","typeId":0}]}\n["x"],["y"]', '{"columns":[{"name":"a","typeId":0}]}\n["unfinished"',
  '{"columns":[{"name":"a","typeId":0},{"name":"a","typeId":0}]}\n["x","y"]', '{"columns":[{"name":"a","typeId":0}]}\n["\\u0000"]',
  '{"columns":[{"name":"a","typeId":0}]}\n["' + 'x'.repeat(16385) + '"]', '{"columns":[{"name":"a","typeId":0}]}\n' + ' '.repeat(1048577)
])('rejects non-exact or malformed JSON Lines (%#)', async data => { await expect(records(data, 65536)).rejects.toThrow() })
it('only suggests exact conservative types and cannot infer non-nullability from a sample', () => {
  const headers = ['id','code','amount','flag','unknown','huge']
  const rows = [['9223372036854775807','001','9007199254740993.12345678','true',null,'9223372036854775808']]
  expect(inferImportColumns('postgres', headers, rows).map(column => column.type)).toEqual(['bigint','text','decimal','boolean','text','text'])
  expect(inferImportColumns('sqlite', headers, rows).map(column => column.type)).toEqual(['bigint','text','text','boolean','text','text'])
  expect(inferImportColumns('mysql', headers, rows)[3].type).toBe('text')
  expect(inferImportColumns('oracle', ['empty'], []).map(column => column.type)).toEqual(['varchar'])
  expect(inferImportColumns('duckdb', headers, rows).every(column => column.nullable)).toBe(true)
})
it('suggests reviewable names for valid file headers that are not SQL identifiers', () => {
  const columns = inferImportColumns('sqlite', ['line\nbreak', 'column_1', 'x'.repeat(300), 'ID', 'id'], [])
  expect(columns.map(column => column.name)).toEqual(['column_1_', 'column_1', 'column_3', 'ID', 'column_5'])
  expect(new Set(columns.map(column => column.name.toLowerCase())).size).toBe(5)
})
it('bounds a file preview and persists only compatible mapping metadata, including across restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-mappings-')), path = join(directory, 'workspace.sqlite'), file = join(directory, 'sensitive.jsonl')
  let store = new WorkspaceStore(path)
  try {
    await writeFile(file, '{"columns":[{"name":"code","typeId":0}]}\n' + Array.from({ length: 25 }, () => '["private row value"]\n').join(''))
    const preview = await inspectDataFile({ file, format: 'jsonl' })
    expect(preview.headers).toEqual(['code']); expect(preview.rows).toHaveLength(10)
    const value = transferMappingSchema.parse({ id: randomUUID(), name: 'Codes', engine: 'sqlite', headers: preview.headers, columns: [{ name: 'identifier', type: 'TEXT' }], mapping: ['identifier'] })
    store.saveTransferMapping(value); store.close(); store = new WorkspaceStore(path)
    expect(store.transferMappings()).toEqual([value])
    expect(compatibleMapping(value, 'sqlite', ['code'], [{ name: 'identifier', type: 'TEXT' }])).toBe(true)
    for (const [engine, headers, columns] of [['postgres',['code'],value.columns], ['sqlite',['CODE'],value.columns], ['sqlite',['code'],[{ name: 'identifier', type: 'INTEGER' }]]] as const) expect(compatibleMapping(value, engine, [...headers], [...columns])).toBe(false)
    expect(() => store.saveTransferMapping({ ...value, file } as typeof value)).toThrow()
    expect(() => store.saveTransferMapping({ ...value, mapping: ['missing'] })).toThrow()
    for (let i = 1; i < 50; i++) store.saveTransferMapping({ ...value, id: randomUUID(), name: `mapping ${i}` })
    expect(() => store.saveTransferMapping({ ...value, id: randomUUID() })).toThrow(/50/)
    store.saveTransferMapping({ ...value, name: 'Updated' }); expect(store.transferMappings()).toHaveLength(50)
    store.removeTransferMapping(value.id); expect(store.transferMappings()).toHaveLength(49)
    store.close(); store = new WorkspaceStore(path)
    const bytes = await readFile(path)
    expect(bytes.includes(Buffer.from('private row value'))).toBe(false)
    expect(bytes.includes(Buffer.from(file))).toBe(false)
  } finally { store.close(); await rm(directory, { recursive: true, force: true }) }
})
