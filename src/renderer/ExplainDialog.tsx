import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from './WorkbenchIcons'
import { engineNames, type SessionInfo } from '../shared/contracts'
import { postgresPlan, separatePlanConnection, type ExplainRequest, type ExplainResult } from '../shared/explain'
import { parameterNames, type QueryParameter } from '../shared/parameters'
import { ParameterDialog } from './ParameterDialog'

export function ExplainDialog({ session, sql, previous, onRun, onClose }: { session: SessionInfo; sql: string; previous?: ExplainResult; onRun(request: ExplainRequest): Promise<ExplainResult>; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<ExplainRequest['mode']>('estimated'), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [result, setResult] = useState(previous?.sql === sql.trim() ? previous : undefined), [raw, setRaw] = useState(session.engine !== 'postgres'), [selected, setSelected] = useState(0), [collapsed, setCollapsed] = useState(new Set<number>())
  const [parameterRequest, setParameterRequest] = useState<{ request: ExplainRequest; names: string[] }>()
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close() }, [])
  const parsed = useMemo(() => {
    if (result?.engine !== 'postgres' || !result.raw) return {}
    try { return { plan: postgresPlan(result.raw) } } catch (error) { return { error: (error as Error).message } }
  }, [result])
  const plan = parsed.plan, node = plan?.nodes[selected]
  const hidden = new Set<number>()
  const visible = plan?.nodes.filter(node => { if (node.parent !== undefined && (collapsed.has(node.parent) || hidden.has(node.parent))) { hidden.add(node.id); return false }; return true })
  function prepare() {
    setError('')
    const names = parameterNames(sql, session.engine, session.mysqlSqlMode?.noBackslashEscapes, session.mysqlSqlMode?.ansiQuotes)
    if (names.length > 100) { setError('A query may use up to 100 distinct named parameters.'); return }
    const request = { sessionId: session.id, sql, mode, executionConfirmed: confirmed }
    if (names.length) setParameterRequest({ request, names })
    else void run(request)
  }
  async function run(request: ExplainRequest, parameters?: QueryParameter[]) {
    setParameterRequest(undefined)
    setBusy(true); setError(''); setMessage(''); setResult(undefined); setCollapsed(new Set()); setSelected(0)
    try { const next = await onRun({ ...request, parameters }); setResult(next); setMessage('') }
    catch (error) { setError((error as Error).message) } finally { setBusy(false); setConfirmed(false) }
  }
  async function save(copy = false) {
    try { if (copy) { await window.dbCommander.copyDefinition(result!.raw); setMessage('Plan copied.') } else if (await window.dbCommander.savePlan({ text: result!.raw, format: result!.format })) setMessage('Plan saved.') }
    catch (error) { setError((error as Error).message) }
  }
  return <dialog ref={dialog} className="connection-dialog explain-dialog" aria-label="Query plan" onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="dialog-heading"><div><h2>Query plan</h2><p>{engineNames[session.engine]} · {session.name} · {session.database || 'Server'}</p></div><button aria-label="Close query plan" disabled={busy} onClick={onClose}><X size={18}/></button></div>
    <p>{separatePlanConnection(session.engine) ? 'Uses a separate connection with this profile’s defaults. Temporary objects, uncommitted changes and tab-specific settings are not included.' : 'Uses this tab’s session, settings and transaction.'} Plans depend on current statistics and permissions; planning can invoke server functions.</p>
    {session.engine === 'oracle' && <p>Oracle estimates do not peek at bind values and can differ from the execution plan. Choose Date, Timestamp or Timestamp with timezone for temporal parameters.</p>}
    <details><summary>Selected SQL</summary><pre className="plan-sql">{sql}</pre></details>
    <div className="plan-controls"><label>Plan mode<select disabled={busy} value={mode} onChange={event => { setMode(event.target.value as typeof mode); setConfirmed(false) }}><option value="estimated">Estimated plan</option>{session.engine === 'postgres' && <option value="analyze">Analyze · executes SQL</option>}</select></label>
      <button className="primary-button" disabled={busy || mode === 'analyze' && !confirmed} onClick={prepare}>{mode === 'analyze' ? 'Execute and analyze' : 'Get estimated plan'}</button>
      {busy && <button onClick={() => void window.dbCommander.cancelExplain(session.id).then(() => setMessage('Cancellation requested; waiting for the database.')).catch(error => setError(error.message))}>Cancel plan</button>}
    </div>
    <p>Parameter values are used for this plan only. Plans can include those values; review the output before copying or saving it. Plans are not saved in query history or workspace recovery.</p>
    {mode === 'analyze' && <label className="plan-warning"><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>I understand this executes the SQL, can change data or call functions, and is not automatically rolled back. In autocommit mode, changes may be committed immediately.</label>}
    {busy && <p role="status">Collecting plan… A cancellation is requested after 60 seconds.</p>}{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {result && <section aria-label="Captured plan"><p role={result.status === 'completed' ? 'status' : 'alert'}>{result.message}</p><p className="plan-summary">Captured {result.mode === 'analyze' ? 'actual' : 'estimated'} plan · {new Date(result.capturedAt).toLocaleString()} · {result.durationMs} ms · {result.session.transaction} transaction state</p>
      {result.status === 'completed' && <><div className="object-actions">{plan && <><button aria-pressed={!raw} onClick={() => setRaw(false)}>Plan tree</button><button aria-pressed={raw} onClick={() => setRaw(true)}>Raw plan</button><button onClick={() => setCollapsed(new Set())}>Expand all nodes</button></>}
        <button onClick={() => void save(true)}>Copy plan</button><button onClick={() => void save()}>Save plan</button></div>
        {parsed.error && <p role="alert">{parsed.error}</p>}
        {!raw && plan ? <><p>Estimated cost is in planner units, not milliseconds. Node costs and times include child work; do not sum them. Actual rows and times are per loop.</p>
          <p className="plan-summary">{plan.nodes.length} operators{plan.planningTime !== undefined ? ` · Planning ${plan.planningTime} ms` : ''}{plan.executionTime !== undefined ? ` · Execution ${plan.executionTime} ms` : ''}</p>{plan.notice && <p>{plan.notice}</p>}
          <div className="plan-visual"><div className="plan-tree" aria-label="PostgreSQL plan tree">{visible?.map(item => <div key={item.id} className="plan-node-row" style={{ marginLeft: Math.min(item.depth, 20) * 22 }}>
            {plan.nodes.some(child => child.parent === item.id) && <button className="plan-collapse" aria-label={`${collapsed.has(item.id) ? 'Expand' : 'Collapse'} node ${item.id + 1}`} aria-expanded={!collapsed.has(item.id)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })}>{collapsed.has(item.id) ? '+' : '−'}</button>}
            <button className={`plan-node ${selected === item.id ? 'selected' : ''}`} aria-label={`Plan node ${item.id + 1}: ${item.type}`} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>
              <strong>{item.type}{item.relation ? ` · ${item.relation}` : ''}</strong><span>Est. rows {item.estimatedRows ?? '—'} · total cost {item.cost ?? '—'}</span>
              {item.actualRows !== undefined && <span>Actual rows {item.actualRows} × {item.loops ?? '—'} loops · {item.time ?? '—'} ms/loop</span>}
              <i className="plan-cost" style={{ width: `${Math.max(1, Math.min(100, (item.cost ?? 0) / (plan.nodes[0].cost || 1) * 100))}%` }}/>
            </button></div>)}</div>
            {node && <aside className="plan-node-details"><h3>{node.type}</h3><p>Operator {node.id + 1} · inclusive cost/time</p><table aria-label="Plan node details"><tbody>{Object.entries(node.details).map(([key,value]) => <tr key={key}><th>{key}</th><td>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</td></tr>)}</tbody></table></aside>}
          </div></> : <textarea className="plan-raw" aria-label="Raw query plan" readOnly spellCheck={false} value={result.raw}/>}
        <details><summary>Submitted plan commands</summary><pre className="plan-sql">{result.submittedSql.join('\n\n')}</pre></details>
      </>}
    </section>}
    {parameterRequest && <ParameterDialog engine={session.engine} sql={parameterRequest.request.sql} names={parameterRequest.names} submitLabel={parameterRequest.request.mode === 'analyze' ? 'Execute and analyze with parameters' : 'Explain with parameters'} onRun={values => run(parameterRequest.request, values)} onClose={() => setParameterRequest(undefined)} />}
  </dialog>
}
