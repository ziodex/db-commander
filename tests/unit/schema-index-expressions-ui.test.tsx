// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { SchemaChangeDialog } from '../../src/renderer/SchemaChangeDialog'
import { MigrationExportDialog } from '../../src/renderer/MigrationExportDialog'
import type { SessionInfo, SchemaSnapshot } from '../../src/shared/contracts'
import type { SchemaChange, SchemaChangePlan } from '../../src/shared/schema-changes'

const table = { schema: 'public', name: 't', kind: 'table' as const, identity: '1' }
const session: SessionInfo = { id: '00000000-0000-4000-8000-000000000001', engine: 'postgres', name: 'test', database: 'test', user: 'test', host: 'localhost', port: 1, tls: false, transaction: 'idle', version: 'PostgreSQL 17.0' }
const snapshot: SchemaSnapshot = { database: 'test', source: 'catalog-connection', fetchedAt: '', truncated: false, catalog: { objects: [table], truncated: false, notice: '' }, objects: [{ schema: 'public', name: 't', kind: 'table', columns: [{ name: 'id', type: 'integer', nullable: false, ordinal: 1 }, { name: 'label', type: 'text', nullable: true, ordinal: 2 }] }] }
const plan: SchemaChangePlan = { id: '00000000-0000-4000-8000-000000000002', sessionId: session.id, engine: 'postgres', database: 'test', connection: 'test', sql: 'CREATE INDEX reviewed;', transaction: 'transactional', destructive: false, warnings: [], expiresAt: '2100-01-01T00:00:00Z' }
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(cleanup)

it('keeps expression positions explicit, invalidates review, and handles removed anchors', async () => {
  const onPrepare = vi.fn(async (_change: SchemaChange) => plan)
  render(<SchemaChangeDialog session={session} snapshot={snapshot} initialTarget={table} onClose={vi.fn()} onPrepare={onPrepare} onApply={vi.fn()}/>)
  fireEvent.change(screen.getByLabelText('Schema operation'), { target: { value: 'create-index' } })
  fireEvent.change(screen.getByLabelText('New object name'), { target: { value: 'idx' } })
  fireEvent.click(screen.getByLabelText('Index column id'))
  fireEvent.click(screen.getByLabelText('Index column label'))
  expect(screen.getByLabelText('Index column id').getAttribute('aria-description')).toBe('Column 1 of 2 in selected order')
  expect(screen.getByLabelText('Index column label').closest('label')?.textContent).toContain('column 2')
  fireEvent.click(screen.getByRole('button', { name: 'Add expression key' }))
  fireEvent.change(screen.getByLabelText('Index expression 1'), { target: { value: 'lower(label)' } })
  fireEvent.change(screen.getByLabelText('Index expression 1 position'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add expression key' }))
  fireEvent.change(screen.getByLabelText('Index expression 2'), { target: { value: 'id + 1' } })
  fireEvent.change(screen.getByLabelText('Index expression 2 position'), { target: { value: '0' } })
  fireEvent.click(screen.getByLabelText('Index expression 2 descending'))
  fireEvent.click(screen.getByRole('button', { name: 'Review SQL' }))
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1))
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ action: 'create-index', columns: ['id','label'], expressions: [{ expression: 'lower(label)', after: 'id', descending: false }, { expression: 'id + 1', after: null, descending: true }] })
  expect(await screen.findByLabelText('Schema SQL preview')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('Index column id'))
  expect(screen.getByLabelText('Index column label').getAttribute('aria-description')).toBe('Column 1 of 1 in selected order')
  expect(screen.getByLabelText('Index column label').closest('label')?.textContent).toContain('column 1')
  expect(screen.queryByLabelText('Schema SQL preview')).toBeNull()
  expect((screen.getByLabelText('Index expression 1 position') as HTMLSelectElement).value).toBe('0')
  fireEvent.click(screen.getByRole('button', { name: 'Review SQL' }))
  await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(2))
  expect(onPrepare.mock.calls[1][0]).toMatchObject({ columns: ['label'], expressions: [{ expression: 'lower(label)', after: null }, { expression: 'id + 1', after: null }] })
})

it('requires specific consent before applying a concurrent index', async () => {
  const concurrentPlan: SchemaChangePlan = { ...plan, transaction: 'nontransactional', sql: 'CREATE INDEX CONCURRENTLY idx ON t(id);' }
  const onPrepare = vi.fn(async (_change: SchemaChange) => concurrentPlan)
  const onApply = vi.fn(async () => ({ status: 'completed' as const, message: 'Created outside a transaction.', session, executedSql: concurrentPlan.sql, durationMs: 1 }))
  render(<SchemaChangeDialog session={session} snapshot={snapshot} initialTarget={table} onClose={vi.fn()} onPrepare={onPrepare} onApply={onApply}/>)
  fireEvent.change(screen.getByLabelText('Schema operation'), { target: { value: 'create-index' } })
  fireEvent.change(screen.getByLabelText('New object name'), { target: { value: 'idx' } })
  fireEvent.click(screen.getByLabelText('Index column id')); fireEvent.click(screen.getByLabelText('Create concurrently'))
  fireEvent.click(screen.getByRole('button', { name: 'Review SQL' })); await screen.findByLabelText('Schema SQL preview')
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ concurrent: true })
  fireEvent.click(screen.getByLabelText('I reviewed this SQL and its target.'))
  expect((screen.getByRole('button', { name: 'Apply reviewed SQL' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('I understand this runs outside a transaction and can leave an invalid index.'))
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed SQL' }))
  await waitFor(() => expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ nontransactionalApproved: true })))
})
it('does not offer a transaction wrapper when exporting a concurrent index', () => {
  render(<MigrationExportDialog sourceId={plan.id} engine="postgres" selected={['change']} includeDestructive={false} requiresAutocommit onClose={vi.fn()}/>)
  expect(screen.queryByRole('option', { name: 'Include BEGIN and COMMIT' })).toBeNull()
  expect(screen.getByText(/requires an idle autocommit connection/)).toBeTruthy()
})
