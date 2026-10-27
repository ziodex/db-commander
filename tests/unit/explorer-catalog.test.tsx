// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExplorerCatalogActions, ExplorerCatalogTree } from '../../src/renderer/ExplorerCatalogTree'
import { explorerTree } from '../../src/renderer/explorer-tree'
import type { CatalogObject } from '../../src/shared/catalog'

afterEach(cleanup)

it('keeps catalog actions current and blocks inspection while the session is busy', () => {
  const table: CatalogObject = { schema: 'main', name: 'orders', kind: 'table', identity: '1' }
  const index: CatalogObject = { ...table, name: 'orders_idx', kind: 'index', identity: '2', parent: table.name }
  const groups = explorerTree([table, index], [], index.name)
  const props = { groups, search: index.name, kind: 'all', filtered: true, expanded: new Set<string>(), collapsedMatches: new Set<string>(), onToggle: vi.fn(), onContext: vi.fn() }
  const previous = vi.fn(), current = vi.fn()
  const view = (busy: boolean, onInspect: (object: CatalogObject) => void) => <ExplorerCatalogActions value={{ busy, onInspect }}><ExplorerCatalogTree {...props}/></ExplorerCatalogActions>
  const rendered = render(view(false, previous))
  const button = rendered.getByRole('button', { name: 'Object details orders_idx on orders' })
  rendered.rerender(view(true, current))
  expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(button)
  expect(previous).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled()
  rendered.rerender(view(false, current))
  fireEvent.click(button)
  expect(previous).not.toHaveBeenCalled()
  expect(current).toHaveBeenCalledExactlyOnceWith(index)
})
