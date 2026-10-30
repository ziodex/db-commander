// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, it } from 'vitest'
import { SchemaConstraintFields } from '../../src/renderer/SchemaConstraintFields'
import type { TableConstraint } from '../../src/shared/schema-changes'

it('exposes composite foreign-key selection order and renumbers each side independently', () => {
  function Form() {
    const [value, setValue] = useState<TableConstraint>({ kind: 'foreign', name: 'fk', columns: [], reference: { kind: 'self' }, referencedColumns: [], onDelete: 'no-action', onUpdate: 'no-action' })
    return <SchemaConstraintFields value={value} onChange={setValue} engine="postgres" localColumns={['a', 'b']} objects={[]} snapshot={null} index={0}/>
  }
  render(<Form/>)
  const localA = screen.getByLabelText('Constraint 1 column a'), localB = screen.getByLabelText('Constraint 1 column b')
  const refA = screen.getByLabelText('Constraint 1 referenced column a'), refB = screen.getByLabelText('Constraint 1 referenced column b')
  fireEvent.click(localA); fireEvent.click(localB); fireEvent.click(refB); fireEvent.click(refA)
  expect(localA.getAttribute('aria-description')).toBe('Column 1 of 2 in selected order')
  expect(localB.getAttribute('aria-description')).toBe('Column 2 of 2 in selected order')
  expect(refB.getAttribute('aria-description')).toBe('Referenced column 1 of 2 in matching order')
  expect(refA.getAttribute('aria-description')).toBe('Referenced column 2 of 2 in matching order')
  fireEvent.click(localA); fireEvent.click(refB)
  expect(localA.hasAttribute('aria-description')).toBe(false)
  expect(refB.hasAttribute('aria-description')).toBe(false)
  expect(localB.getAttribute('aria-description')).toBe('Column 1 of 1 in selected order')
  expect(refA.getAttribute('aria-description')).toBe('Referenced column 1 of 1 in matching order')
})
