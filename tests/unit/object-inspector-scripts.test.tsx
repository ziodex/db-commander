// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { ObjectInspector, type ObjectView } from '../../src/renderer/ObjectInspector'
import type { SessionInfo } from '../../src/shared/contracts'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(cleanup)

it('previews a chosen script and opens it without running SQL', () => {
  const object = { schema: 'public', name: 'items', identity: '42', kind: 'view' as const }
  const view: ObjectView = { tabId: 'tab', sessionId: 'session', object, loading: false, detail: { object, sections: [], fetchedAt: '2026-01-01T00:00:00Z', source: 'catalog-connection', definition: { source: 'generated', sql: 'CREATE VIEW "public"."items" AS SELECT 1' } } }
  const onOpen = vi.fn()
  const session: SessionInfo = { id: 'session', engine: 'postgres', name: 'test', database: 'test', user: 'test', host: 'localhost', port: 1, tls: false, transaction: 'idle', version: '17' }
  render(<ObjectInspector view={view} session={session} onClose={vi.fn()} onRefresh={vi.fn()} onOpen={onOpen} onPrepare={vi.fn()} onApply={vi.fn()}/> )
  expect(screen.getByText(/generated summary; metadata or options may be omitted/i)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Object script'), { target: { value: 'drop' } })
  expect((screen.getByLabelText('Object script preview') as HTMLTextAreaElement).value).toBe('DROP VIEW "public"."items";')
  expect(onOpen).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Open script in new tab' }))
  expect(onOpen).toHaveBeenCalledWith('DROP VIEW "public"."items";', 'items-drop.sql')
})
