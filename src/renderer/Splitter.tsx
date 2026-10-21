import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { clampSize } from '../shared/layout'

/** Pointer capture keeps resizing reliable across Monaco and virtualized grids. */
export function Splitter({ orientation, label, controls, value, preferredValue, min, max, onChange, onToggle, onReset, disabled }: {
  orientation: 'vertical' | 'horizontal'; label: string; controls: string; value: number; preferredValue: number; min: number; max: number
  onChange(value: number): void; onToggle(): void; onReset(): void; disabled: boolean
}) {
  const drag = useRef<{ id: number; coordinate: number; value: number; preferredValue: number } | null>(null)
  const vertical = orientation === 'vertical'
  const callbacks = useRef({ onChange }); callbacks.current = { onChange }
  function finish(event: PointerEvent<HTMLDivElement>, cancel = false) {
    if (!drag.current || event.pointerId !== drag.current.id) return
    const previous = drag.current; drag.current = null
    if (cancel) onChange(previous.preferredValue)
    delete document.body.dataset.resizing
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  useEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault(); event.stopPropagation()
        callbacks.current.onChange(drag.current.preferredValue); drag.current = null
        delete document.body.dataset.resizing
      }
    }
    const blur = () => { drag.current = null; delete document.body.dataset.resizing }
    window.addEventListener('keydown', cancel, true); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', cancel, true); window.removeEventListener('blur', blur); if (drag.current) delete document.body.dataset.resizing }
  }, [])
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return
    const step = event.shiftKey ? 50 : 10
    const change = vertical ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: step, ArrowDown: -step }
    const delta = change[event.key as keyof typeof change]
    if (delta !== undefined || ['Home', 'End', 'Enter'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation()
      if (event.key === 'Enter') onToggle()
      else onChange(clampSize(event.key === 'Home' ? min : event.key === 'End' ? max : value + delta!, min, max))
    }
  }
  return <div className={`panel-splitter ${orientation}`} role="separator" aria-label={label} aria-orientation={orientation}
    aria-controls={controls} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value} pixels`}
    aria-disabled={disabled} tabIndex={disabled ? -1 : 0} title={`${label}: drag or use arrow keys. Shift for larger steps; Home/End for limits; Enter to hide. Double-click to reset size.`}
    onKeyDown={key} onDoubleClick={() => { if (!disabled) onReset() }}
    onPointerDown={event => {
      if (disabled || !event.isPrimary || event.button !== 0) return
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { id: event.pointerId, coordinate: vertical ? event.clientX : event.clientY, value, preferredValue }
      document.body.dataset.resizing = orientation
    }}
    onPointerMove={event => {
      const start = drag.current
      if (!start || start.id !== event.pointerId) return
      const delta = (vertical ? event.clientX : event.clientY) - start.coordinate
      onChange(clampSize(start.value + (vertical ? delta : -delta), min, max))
    }} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event)} />
}
