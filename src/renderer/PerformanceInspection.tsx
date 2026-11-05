import type { PerformanceSnapshot } from '../shared/performance'

const bases = { current: 'Current', cumulative: 'Cumulative', interval: 'Last interval' } as const

export function PerformanceInspection({ snapshot, busy, onRefresh }: {
  snapshot?: PerformanceSnapshot
  busy: boolean
  onRefresh(): void
}) {
  return <section aria-label="Performance snapshot">
    <div className="diagnostic-summary">
      {snapshot && <p className="activity-scope"><strong>{snapshot.scope}</strong><br/>Captured {new Date(snapshot.capturedAt).toLocaleString()}
        {snapshot.reference && <><br/>{snapshot.reference}</>}</p>}
      <button className="primary-button" disabled={busy} onClick={onRefresh}>Refresh performance</button>
    </div>
    {snapshot && <>
      {snapshot.status === 'available' && <div className="activity-table performance-table" tabIndex={0} aria-label="Captured performance counters">
        <table>
          <thead><tr><th>Metric</th><th>Value</th><th>Basis</th></tr></thead>
          <tbody>{snapshot.metrics.map(metric => <tr key={metric.label}>
            <td>{metric.label}</td>
            <td>{metric.value}{metric.unit === '%' ? '%' : metric.unit === 'count' ? '' : ` ${metric.unit}`}</td>
            <td>{bases[metric.basis]}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <p role={snapshot.status === 'unavailable' ? 'alert' : undefined}>{snapshot.note}</p>
      {snapshot.status === 'available' && <p className="diagnostic-note">This snapshot stays in the window and excludes SQL text.</p>}
    </>}
  </section>
}
