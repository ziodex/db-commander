// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ObjectSourceEditor } from '../../src/renderer/ObjectSourceEditor'
import type { ObjectDetail } from '../../src/shared/catalog'
import type { SessionInfo } from '../../src/shared/contracts'
import type { SchemaChangePlan } from '../../src/shared/schema-changes'

const session: SessionInfo = { id: '00000000-0000-4000-8000-000000000001', engine: 'postgres', name: 'test', database: 'test', user: 'test', host: 'localhost', port: 1, tls: false, transaction: 'idle', version: '17' }
const object = { schema: 'public', name: 'items', kind: 'view' as const, identity: '1' }
const detail: ObjectDetail = { object, source: 'catalog-connection', fetchedAt: '', sections: [], definition: { sql: 'CREATE VIEW public.items AS SELECT 1', source: 'generated' } }
const plan: SchemaChangePlan = { id: '00000000-0000-4000-8000-000000000002', sessionId: session.id, engine: 'postgres', database: 'test', connection: 'test', sql: 'BEGIN;\n\nCREATE OR REPLACE VIEW public.items AS SELECT 2', transaction: 'transactional', destructive: true, warnings: [], expiresAt: '2100-01-01T00:00:00Z' }
afterEach(cleanup)

it('retains a draft when a refreshed definition conflicts and requires an explicit new baseline', async () => {
  const onPrepare = vi.fn(async () => plan), onRefresh = vi.fn(), props = { session, initialSql: 'CREATE OR REPLACE VIEW public.items AS SELECT 1', onPrepare, onApply: vi.fn(), onRefresh, onExit: vi.fn() }
  const { rerender } = render(<ObjectSourceEditor {...props} detail={detail}/>)
  fireEvent.change(screen.getByLabelText('Edited source'), { target: { value: 'CREATE OR REPLACE VIEW public.items AS SELECT 2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Check current definition' })); expect(onRefresh).toHaveBeenCalledOnce()
  const latest = { ...detail, definition: { ...detail.definition, sql: 'CREATE VIEW public.items AS SELECT 3' } }
  rerender(<ObjectSourceEditor {...props} detail={latest}/>)
  expect((screen.getByLabelText('Edited source') as HTMLTextAreaElement).value).toContain('SELECT 2')
  expect((screen.getByRole('button', { name: 'Review source SQL' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByLabelText('Latest database definition') as HTMLTextAreaElement).value).toContain('SELECT 3')
  fireEvent.click(screen.getByRole('button', { name: 'Use latest as comparison baseline' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review source SQL' }))
  await waitFor(() => expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({ baseDefinition: latest.definition.sql, sql: expect.stringContaining('SELECT 2') })))
})

it('requires SQL and destructive acknowledgements before applying the retained plan', async () => {
  const onApply = vi.fn(async () => ({ status: 'completed' as const, session, message: 'Applied in transaction.', executedSql: plan.sql, durationMs: 1 }))
  render(<ObjectSourceEditor detail={detail} session={session} initialSql={plan.sql.split('\n\n')[1]} onPrepare={vi.fn(async () => plan)} onApply={onApply} onRefresh={vi.fn()} onExit={vi.fn()}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Review source SQL' })); await screen.findByLabelText('Source SQL preview')
  const apply = screen.getByRole('button', { name: 'Apply reviewed source' }) as HTMLButtonElement
  expect(apply.disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('I reviewed this SQL and its target.')); expect(apply.disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('I understand this may change or remove an existing object and its dependencies.'))
  fireEvent.click(apply)
  await waitFor(() => expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ planId: plan.id, destructiveApproved: true })))
  expect((await screen.findByText('Applied in transaction.')).getAttribute('role')).toBe('status')
})
