import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { columnWidth, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH } from './column-sizing'

/** Column identity is its original result ordinal, regardless of display order. */
export function ColumnResizer({ label, width, onResize, onFit, onReset }: {
  label: string; width: number; onResize(width: number): void; onFit(): void; onReset(): void
}) {
  const callbacks = useRef({ onResize, onFit, onReset }); callbacks.current = { onResize, onFit, onReset }
  const drag = useRef<{ id: number; x: number; width: number; element: HTMLSpanElement; cleanup(): void } | null>(null)
  function finish(cancel = false) {
    const previous = drag.current
    if (!previous) return
    drag.current = null; previous.cleanup()
    delete document.body.dataset.columnResizing
    if (previous.element.hasPointerCapture(previous.id)) previous.element.releasePointerCapture(previous.id)
    if (cancel) callbacks.current.onResize(previous.width)
  }
  useEffect(() => () => { finish() }, [])
  function key(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || drag.current) return
    const step = event.shiftKey ? 50 : 10
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'Backspace', 'Delete'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    if (event.key === 'Enter') callbacks.current.onFit()
    else if (event.key === 'Backspace' || event.key === 'Delete') callbacks.current.onReset()
    else callbacks.current.onResize(columnWidth(event.key === 'Home' ? MIN_COLUMN_WIDTH : event.key === 'End' ? MAX_COLUMN_WIDTH : width + (event.key === 'ArrowLeft' ? -step : step)))
  }
  function resize(event: PointerEvent<HTMLSpanElement>) {
    const start = drag.current
    if (start && start.id === event.pointerId) callbacks.current.onResize(columnWidth(start.width + event.clientX - start.x))
  }
  return <span className="column-resizer" role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical"
    aria-valuemin={MIN_COLUMN_WIDTH} aria-valuemax={MAX_COLUMN_WIDTH} aria-valuenow={width} aria-valuetext={`${width} pixels`}
    title="Drag to resize. Double-click or Enter fits loaded values. Left/Right resize; Shift uses larger steps. Home/End set limits. Delete resets. Escape cancels a drag."
    onKeyDown={key} onBlur={() => finish(true)} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); callbacks.current.onFit() }}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || drag.current) return
      event.preventDefault(); event.stopPropagation()
      const element = event.currentTarget
      element.focus({ preventScroll: true }); element.setPointerCapture(event.pointerId)
      const escape = (input: globalThis.KeyboardEvent) => {
        if (input.key === 'Escape') { input.preventDefault(); input.stopPropagation(); finish(true) }
      }
      const blur = () => finish(true)
      window.addEventListener('keydown', escape, true); window.addEventListener('blur', blur)
      drag.current = { id: event.pointerId, x: event.clientX, width, element, cleanup: () => {
        window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', blur)
      } }
      document.body.dataset.columnResizing = 'true'
    }} onPointerMove={resize} onPointerUp={event => {
      if (drag.current?.id === event.pointerId) { resize(event); finish() }
    }} onPointerCancel={event => { if (drag.current?.id === event.pointerId) finish(true) }}
    onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) finish(true) }}/>
}
