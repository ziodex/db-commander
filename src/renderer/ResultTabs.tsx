import type { ResultSet } from '../shared/contracts'
import { resultCommand, resultCount, resultDescription } from './result-navigation'
import { useLayoutEffect, useRef } from 'react'

export function ResultTabs({ results, selected, onSelect }: { results: ResultSet[]; selected: number; onSelect(index: number): void }) {
  const strip = useRef<HTMLDivElement>(null), count = results.filter(Boolean).length
  useLayoutEffect(() => {
    const element = strip.current, active = element?.querySelector<HTMLElement>('button[aria-pressed=true]')
    if (!element || !active) return
    const reveal = () => {
      const frame = element.getBoundingClientRect(), bounds = active.getBoundingClientRect()
      // Leave a small inset so integer scroll offsets do not clip a fractional
      // CSS pixel at native zoom levels.
      const left = frame.left + element.clientLeft + 4, right = frame.left + element.clientLeft + element.clientWidth - 4
      // Move only the result strip, preserving keyboard focus and pane scroll.
      element.scrollLeft += bounds.left < left ? bounds.left - left : Math.max(0, bounds.right - right)
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(element); observer.observe(active)
    return () => observer.disconnect()
  }, [selected, count])
  if (count < 2) return null
  return <div ref={strip} className="result-tabs" role="group" aria-label="Result sets">
    {results.map(result => <button key={result.index} aria-label={`Result ${result.index + 1}`} aria-description={resultDescription(result)} title={resultDescription(result)}
      aria-pressed={selected === result.index} className={selected === result.index ? 'selected' : ''} onClick={() => onSelect(result.index)}>
      <span>Result {result.index + 1} · {resultCommand(result)}</span>
      <small>{result.columns.length ? `${result.rows.length.toLocaleString()} ${result.rows.length === 1 ? 'row' : 'rows'}${result.truncated ? ' · limited' : ''}` : resultCount(result)}</small>
    </button>)}
  </div>
}
