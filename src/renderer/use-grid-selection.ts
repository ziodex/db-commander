import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import { selectionBounds, type GridPoint, type GridSelection } from './grid-selection'

export function useGridSelection(scroll: RefObject<HTMLDivElement | null>, visible: number[], rowCount: number, focusCell: (point: GridPoint) => void, resetKey = '') {
  const [selection, setSelection] = useState<GridSelection | null>(null)
  const current = useRef(selection), frame = useRef(0)
  const dragging = useRef<{ id: number; x: number; y: number } | null>(null)
  // A changed column order starts a fresh range rather than silently changing what Copy includes.
  const signature = `${visible.join(',')}:${resetKey}`, previous = useRef(signature)
  if (previous.current !== signature) { previous.current = signature; current.current = null; setSelection(null) }
  function select(point: GridPoint, extend = false) {
    const anchor = extend && current.current ? current.current.anchor : point
    current.current = { anchor, focus: point }; setSelection(current.current)
  }
  function stop() { dragging.current = null; cancelAnimationFrame(frame.current); frame.current = 0 }
  useEffect(() => {
    window.addEventListener('blur', stop)
    return () => { window.removeEventListener('blur', stop); stop() }
  }, [])
  function pointAt(target: EventTarget | null): GridPoint | undefined {
    const cell = target instanceof Element ? target.closest<HTMLElement>('[data-result-row][data-result-column]') : null
    if (cell && scroll.current?.contains(cell)) return { row: Number(cell.dataset.resultRow), column: Number(cell.dataset.resultColumn) }
  }
  function track() {
    const viewport = scroll.current, pointer = dragging.current
    if (!viewport || !pointer) return
    const bounds = viewport.getBoundingClientRect(), header = viewport.querySelector('.grid-header')?.getBoundingClientRect()
    const top = header?.bottom ?? bounds.top, bottom = bounds.top + viewport.clientHeight
    const right = bounds.left + viewport.clientWidth
    const speed = (value: number, min: number, max: number) => value < min + 20 ? -Math.min(24, (min + 20 - value) / 2) : value > max - 20 ? Math.min(24, (value - max + 20) / 2) : 0
    viewport.scrollTop += speed(pointer.y, top, bottom)
    viewport.scrollLeft += speed(pointer.x, bounds.left, right)
    const point = pointAt(document.elementFromPoint(Math.max(bounds.left + 2, Math.min(pointer.x, right - 2)), Math.max(top + 2, Math.min(pointer.y, bottom - 2))))
    if (point && (point.row !== current.current?.focus.row || point.column !== current.current?.focus.column)) select(point, true)
    frame.current = requestAnimationFrame(track)
  }
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const point = pointAt(event.target)
    if (!point) return
    event.preventDefault()
    select(point, event.shiftKey); focusCell(point)
    // A plain click must not extend to a neighbour merely because it is near an edge.
    dragging.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging.current || dragging.current.id !== event.pointerId) return
    dragging.current.x = event.clientX; dragging.current.y = event.clientY
    const point = pointAt(document.elementFromPoint(event.clientX, event.clientY))
    if (point) select(point, true)
    if (!frame.current) frame.current = requestAnimationFrame(track)
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragging.current || dragging.current.id !== event.pointerId) return
    const point = current.current?.focus
    stop(); frame.current = 0
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (point) focusCell(point)
  }
  return { selection, current, select, bounds: selectionBounds(selection, visible, rowCount),
    pointerEvents: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: () => { stop(); frame.current = 0 }, onLostPointerCapture: () => { stop(); frame.current = 0 } } }
}
