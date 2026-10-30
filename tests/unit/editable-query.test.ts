import { expect, it } from 'vitest'
import { editableQueryTable } from '../../src/renderer/editable-query'
import type { SchemaTable, SessionInfo } from '../../src/shared/contracts'

const session: SessionInfo = { id: 's', engine: 'postgres', name: 'test', database: 'db', user: 'u', host: 'host', port: 1, tls: false, transaction: 'idle', version: '' }
const tables: SchemaTable[] = [{ schema: 'public', name: 'items', kind: 'table' }, { schema: 'public', name: 'view', kind: 'view' }, { schema: 'Case', name: 'Odd Name', kind: 'table' }]

it('recognizes a single explicitly qualified source while leaving its SQL untouched', () => {
  expect(editableQueryTable('SELECT * FROM public.items;', session, tables)).toEqual({ schema: 'public', name: 'items' })
  expect(editableQueryTable('select * from "Case"."Odd Name"', session, tables)).toEqual({ schema: 'Case', name: 'Odd Name' })
  expect(editableQueryTable('SELECT * FROM PUBLIC.ITEMS', session, tables)).toEqual({ schema: 'public', name: 'items' })
})
it('refuses ambiguous, filtered, projected, compound, commented and non-table queries', () => {
  for (const sql of ['SELECT * FROM items', 'SELECT id FROM public.items', 'SELECT * FROM public.items WHERE id=1', 'SELECT * FROM public.items; DELETE FROM public.items', 'SELECT * FROM public.view', 'SELECT * FROM public.items -- comment', 'SELECT * FROM public.items i', 'SELECT * FROM public.items JOIN public.items x ON true']) expect(editableQueryTable(sql, session, tables), sql).toBeUndefined()
  expect(editableQueryTable('SELECT * FROM public.items', session, [...tables, tables[0]])).toBeUndefined()
})
