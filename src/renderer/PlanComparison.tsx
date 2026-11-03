import { useMemo, useState } from 'react'
import { comparePlanOperators, explainTree } from '../shared/plan-tree'
import type { ExplainResult, PlanTree } from '../shared/explain'

const PAGE_SIZE = 40
function onlyRoot(tree?: PlanTree) {
  const roots = tree?.nodes.filter(node => node.parent === undefined)
  return roots?.length === 1 ? roots[0] : undefined
}

export function PlanComparison({ baseline, current, plan }: { baseline: ExplainResult; current: ExplainResult; plan?: PlanTree }) {
  const [page, setPage] = useState(0)
  const before = useMemo(() => {
    try { return explainTree(baseline) } catch { return undefined }
  }, [baseline])
  const changes = useMemo(() => before && plan ? comparePlanOperators(before, plan) : undefined, [before, plan])
  const size = changes?.length ?? 0, pages = Math.max(1, Math.ceil(size / PAGE_SIZE))
  const selectedPage = Math.min(page, pages - 1)
  const leftRoot = onlyRoot(before), rightRoot = onlyRoot(plan)
  const captureTime = (result: ExplainResult) => new Date(result.capturedAt).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3
  })
  const sameSql = baseline.sql === current.sql
  return <section aria-label="Compare captured plans" className="plan-comparison">
    <h3>Compare captured plans</h3>
    <p>{sameSql ? 'The submitted SQL text is identical.' : 'The submitted SQL text differs.'} Captures may use different parameters, settings or statistics. Planner costs are native estimates. Capture time includes plan collection and transport.</p>
    <div className="plan-comparison-scroll"><table aria-label="Plan comparison metrics">
      <thead><tr><th scope="col">Metric</th><th scope="col">Baseline</th><th scope="col">Current</th></tr></thead>
      <tbody>
        <tr><th scope="row">Captured</th><td>{captureTime(baseline)}</td><td>{captureTime(current)}</td></tr>
        <tr><th scope="row">Transaction state</th><td>{baseline.session.transaction}</td><td>{current.session.transaction}</td></tr>
        <tr><th scope="row">Capture duration</th><td>{baseline.durationMs} ms</td><td>{current.durationMs} ms</td></tr>
        <tr><th scope="row">Displayed operators</th><td>{before?.nodes.length ?? 'Unavailable'}</td><td>{plan?.nodes.length ?? 'Unavailable'}</td></tr>
        {(leftRoot?.cost !== undefined || rightRoot?.cost !== undefined) && <tr><th scope="row">Root planner cost</th><td>{leftRoot?.cost ?? 'Unavailable'}</td><td>{rightRoot?.cost ?? 'Unavailable'}</td></tr>}
        {(before?.executionTime !== undefined || plan?.executionTime !== undefined) && <tr><th scope="row">Reported execution time</th><td>{before?.executionTime === undefined ? 'Unavailable' : `${before.executionTime} ms`}</td><td>{plan?.executionTime === undefined ? 'Unavailable' : `${plan.executionTime} ms`}</td></tr>}
      </tbody>
    </table></div>
    <p>{baseline.raw === current.raw ? 'The captured raw outputs are identical.' : 'The captured raw outputs differ.'}</p>
    {(before?.notice || plan?.notice) && <p>Operator counts cover the displayed trees. Inspect each native capture for details outside those trees.</p>}
    {changes && (changes.length ? <><div className="plan-comparison-scroll"><table aria-label="Changed operator counts">
      <thead><tr><th scope="col">Operator</th><th scope="col">Baseline count</th><th scope="col">Current count</th></tr></thead>
      <tbody>{changes.slice(selectedPage * PAGE_SIZE, (selectedPage + 1) * PAGE_SIZE).map(change =>
        <tr key={change.key}><th scope="row">{change.type}{change.relation ? ` · ${change.relation}` : ''}</th><td>{change.before}</td><td>{change.after}</td></tr>
      )}</tbody>
    </table></div>{pages > 1 && <div className="comparison-controls">
      <button disabled={selectedPage === 0} onClick={() => setPage(selectedPage - 1)}>Previous operator changes</button><span>Page {selectedPage + 1} of {pages}</span>
      <button disabled={selectedPage + 1 >= pages} onClick={() => setPage(selectedPage + 1)}>Next operator changes</button>
    </div>}</> : <p>The displayed operator counts match. Order, predicates and estimates can still differ.</p>)}
    <details><summary>Baseline SQL and raw plan</summary><pre className="plan-sql">{baseline.sql}</pre>
      <textarea className="plan-raw" aria-label="Baseline raw plan" readOnly spellCheck={false} value={baseline.raw}/>
    </details>
  </section>
}
