import { useEffect, useRef, useState } from 'react'
import { preparePrincipalChangeSchema, type ApplyPrincipalChange, type PreparePrincipalChange, type PrincipalChangeResult, type PrincipalChangeReview } from '../shared/principal-changes'
import { engineNames } from '../shared/database-engines'
import { mysqlRelationPrivileges, oracleRelationPrivileges, relationPrivileges, sqlServerRelationPrivileges, type PrincipalRelation, type PrincipalRole, type PrincipalScope } from '../shared/principals'

type Change = PreparePrincipalChange['change']
type Action = Change['action']
type ScopedReview = PrincipalChangeReview & { scopeLabel: string }
const actions = {
  create: 'Create role without login', 'create-login': 'Create login role',
  'create-user': 'Create user without login', 'create-mapped-user': 'Create user for an existing login',
  rename: 'Rename role', 'enable-login': 'Enable login', 'disable-login': 'Disable login', drop: 'Drop role',
  grant: 'Grant role membership', revoke: 'Revoke role membership',
  'grant-session': 'Grant CREATE SESSION', 'revoke-session': 'Revoke CREATE SESSION',
  'grant-relation': 'Grant relation privilege', 'deny-relation': 'Deny relation privilege', 'revoke-relation': 'Revoke relation privilege'
} satisfies Record<Action, string>
const mysqlLabels: Partial<Record<Action, string>> = {
  create: 'Create role', 'create-login': 'Create locked user account', rename: 'Rename account',
  'enable-login': 'Unlock account', 'disable-login': 'Lock account', drop: 'Drop account or role'
}
const sqlServerLabels: Partial<Record<Action, string>> = {
  create: 'Create role', 'create-login': 'Create SQL login', rename: 'Rename principal', drop: 'Drop principal'
}

const oracleLabels: Partial<Record<Action, string>> = {
  create: 'Create role', 'create-user': 'Create schema-only user', 'create-login': 'Create locked login user',
  'enable-login': 'Unlock account', 'disable-login': 'Lock account', drop: 'Drop user or role'
}

function ChangeContext({ review, id }: { review: ScopedReview; id?: string }) {
  return <div className="principal-change-context" id={id}>
    <p><strong>{review.scopeLabel}</strong>{review.implicitCommit && ' · Commits automatically'}</p>
    <code>{review.sql}</code>
  </div>
}

export function PrincipalChangeEditor({ session, scope, role, relation, busy, error, work, prepare, apply, invalidate, refresh }: {
  session: import('../shared/contracts').SessionInfo
  scope: PrincipalScope
  role?: PrincipalRole
  relation?: PrincipalRelation
  busy: boolean
  error: string
  work(action: () => Promise<void>): Promise<void>
  prepare(change: Change): Promise<PrincipalChangeReview>
  apply(request: Omit<ApplyPrincipalChange, 'sessionId'>): Promise<PrincipalChangeResult>
  invalidate(): void
  refresh(): void
}) {
  const engine = session.engine
  const mysql = engine === 'mysql' || engine === 'mariadb'
  const tsql = engine === 'sqlserver' || engine === 'azure-sql'
  const server = tsql && scope === 'server'
  const oracle = engine === 'oracle'
  const engineName = engineNames[engine]
  const [action, setAction] = useState<Action>(server && engine === 'azure-sql' ? 'create-login' : 'create')
  const [name, setName] = useState(''), [member, setMember] = useState('')
  const [login, setLogin] = useState('')
  const [host, setHost] = useState(''), [memberHost, setMemberHost] = useState('')
  const [privilege, setPrivilege] = useState<string>('SELECT')
  const [review, setReview] = useState<ScopedReview>()
  const [confirmation, setConfirmation] = useState(''), [acknowledge, setAcknowledge] = useState(false)
  const [acknowledgeCommit, setAcknowledgeCommit] = useState(false)
  const password = useRef<HTMLInputElement>(null)
  const [passwordEntered, setPasswordEntered] = useState(false)
  const [outcome, setOutcome] = useState<{ result: PrincipalChangeResult; review: ScopedReview }>()
  const [copyStatus, setCopyStatus] = useState('')
  const [stage, setStage] = useState('')
  const reviewHeading = useRef<HTMLHeadingElement>(null), resultHeading = useRef<HTMLHeadingElement>(null)
  const actionSelect = useRef<HTMLSelectElement>(null), returningToForm = useRef(false)
  const errorNotice = useRef<HTMLParagraphElement>(null)
  const create = action === 'create' || action === 'create-login' || action === 'create-user' || action === 'create-mapped-user'
  const membership = action === 'grant' || action === 'revoke'
  const relationChange = action === 'grant-relation' || action === 'revoke-relation' || action === 'deny-relation'
  const needsName = create || action === 'rename'
  const needsHost = mysql && needsName && (engine !== 'mariadb' || action !== 'create')
  const mariaRole = engine === 'mariadb' && role?.account?.host === ''
  const loginChange = action === 'enable-login' || action === 'disable-login'
  const unsupportedOracle = oracle && loginChange && role?.canGrantMembership
  const unsupported = unsupportedOracle || engine === 'mariadb' && role && (
    mariaRole ? ['rename', 'enable-login', 'disable-login'].includes(action) : membership)
  const ready = (create || role) && !unsupported && (!needsName || name.trim()) && (!needsHost || host.trim()) &&
    (!membership || member.trim() && (engine !== 'mysql' || memberHost.trim()) && (!(tsql || oracle) || role?.canGrantMembership)) &&
    (!relationChange || relation) && (action !== 'create-mapped-user' || login.trim())
  const locked = Boolean(session.safety?.protected && session.safety.unlockedUntil <= Date.now())
  const canApply = review && !busy && !locked && acknowledge && confirmation === review.confirmation &&
    (!review.implicitCommit || acknowledgeCommit) && (!review.requiresPassword || passwordEntered)

  const choices = (Object.keys(actions) as Action[]).filter(value => {
    if (value === 'grant-session' || value === 'revoke-session') return oracle
    if (value === 'create-user') return oracle || tsql && !server
    if (value === 'create-mapped-user' || value === 'deny-relation') return tsql && !server
    if (value === 'rename' && oracle) return false
    if (tsql && (value === 'enable-login' || value === 'disable-login' || value === 'create-login')) return server
    if (server && (value === 'grant-relation' || value === 'revoke-relation')) return false
    if (server && engine === 'azure-sql' && (value === 'create' || value === 'drop')) return false
    return true
  })
  const nameLabel = mysql && action !== 'create' ? 'New account name'
    : action === 'create-user' || action === 'create-mapped-user' ? 'New database user name'
    : oracle && action === 'create-login' ? 'New database user name'
    : tsql && action === 'create-login' ? 'New login name'
    : tsql && action === 'rename' ? 'New principal name' : 'New role name'

  function currentChange(): Change {
    const identity = mysql ? { account: { user: name, host: needsHost ? host : '' } } : { name }
    const change = {
      action, ...(tsql ? { engine, scope } : mysql || oracle ? { engine } : {}),
      ...(create || action === 'rename' ? identity : {}),
      ...(!create ? { roleId: role?.id } : {}),
      ...(membership ? { member: mysql ? { user: member, host: memberHost } : member } : {}),
      ...(relationChange ? { relation, privilege } : {}),
      ...(action === 'create-mapped-user' ? { login } : {})
    }
    return preparePrincipalChangeSchema.parse({ sessionId: session.id, change }).change
  }

  function prepareReview() {
    setStage('Checking current roles and grants…')
    void work(async () => {
      const change = currentChange()
      const plan = await prepare(change)
      setReview({ ...plan, scopeLabel: reviewedScope(plan, change) })
    })
  }

  function discardReview() {
    setReview(undefined); setConfirmation(''); setAcknowledge(false); setAcknowledgeCommit(false); setCopyStatus(''); setPasswordEntered(false)
    if (password.current) password.current.value = ''
  }

  function reviewedScope(plan: PrincipalChangeReview, change: Change) {
    if (oracle) return `Container · ${plan.database}`
    if (server) return `Server · ${plan.database}`
    if ('relation' in change) return `Database · ${mysql ? change.relation.schema : plan.database}`
    if (tsql) return `Database · ${plan.database}`
    return mysql ? 'Server-wide account or role change' : 'Cluster-wide role change'
  }

  function execute() {
    if (!review || !canApply) return
    setStage('Applying the reviewed change…')
    void work(async () => {
      const newPassword = review.requiresPassword ? password.current?.value : undefined
      discardReview()
      try {
        const result = await apply({
          reviewId: review.id, confirmation, acknowledge: true,
          ...(newPassword !== undefined ? { newPassword } : {}),
          ...(review.implicitCommit ? { acknowledgeImplicitCommit: true as const } : {})
        })
        setOutcome({ result, review })
      }
      finally { invalidate() }
    })
  }

  useEffect(() => {
    if (review) reviewHeading.current?.focus()
    else if (returningToForm.current) {
      returningToForm.current = false
      actionSelect.current?.focus()
    }
  }, [review])
  useEffect(() => { if (outcome) resultHeading.current?.focus() }, [outcome])
  useEffect(() => { if (error) errorNotice.current?.focus() }, [error])

  return <div className="principal-change-editor">
    {outcome ? <section className="activity-detail" aria-labelledby="principal-change-result">
      <h3 id="principal-change-result" tabIndex={-1} ref={resultHeading}>
        {outcome.result.status === 'applied' ? 'Change applied' : outcome.result.status === 'rolled-back' ? 'Change rolled back' : outcome.result.status === 'rejected' ? 'Change rejected' : 'Outcome unknown'}
      </h3>
      <ChangeContext review={outcome.review} />
      <p>{outcome.result.message}</p>
      <button type="button" onClick={refresh}>{tsql || mysql || oracle ? 'Refresh principals' : 'Refresh roles'}</button>
    </section> : review ? <section className="activity-detail" aria-labelledby="principal-change-review">
      <h3 id="principal-change-review" tabIndex={-1} ref={reviewHeading}>Review {engineName} change</h3>
      <p>Connected as <strong>{review.observer}</strong> in <strong>{review.database}</strong> · Review expires at <time dateTime={review.expiresAt}>{new Date(review.expiresAt).toLocaleTimeString()}</time></p>
      <textarea aria-label={`Reviewed ${engineName} SQL`} value={review.sql} readOnly spellCheck={false} />
      <ul>{review.notes.map(note => <li key={note}>{note}</li>)}</ul>
      {review.requiresPassword ? <label>New login password
        <input type="password" ref={password} autoComplete="new-password" maxLength={128} disabled={busy || locked}
          onChange={event => setPasswordEntered(Boolean(event.target.value))} />
      </label> : <div className="principals-copy">
        <button type="button" aria-disabled={busy} onClick={() => {
          if (busy) return
          setStage('Copying SQL…')
          void work(async () => { await window.dbCommander.copyDefinition(review.sql); setCopyStatus('SQL copied.') })
        }}>Copy SQL</button>
        <span role="status">{copyStatus}</span>
      </div>}
      {locked && <p>Unlock the protected connection before applying a change.</p>}
      <label className="activity-check">
        <input type="checkbox" disabled={busy || locked} checked={acknowledge} onChange={event => setAcknowledge(event.target.checked)} />
        I reviewed the SQL and its effects.
      </label>
      {review.implicitCommit && <label className="activity-check">
        <input type="checkbox" disabled={busy || locked} checked={acknowledgeCommit} onChange={event => setAcknowledgeCommit(event.target.checked)} />
        I understand this change commits automatically.
      </label>}
      <label><span>Type <strong>{review.confirmation}</strong> to confirm</span>
        <input aria-label="Confirmation text" value={confirmation} maxLength={128} disabled={busy || locked} onChange={event => setConfirmation(event.target.value)} />
      </label>
      <ChangeContext id="principal-change-context" review={review} />
      <div className="principals-copy">
        <button type="button" disabled={busy} onClick={() => { returningToForm.current = true; discardReview() }}>Back to change</button>
        <button className="primary-button" type="button" disabled={!canApply}
          aria-describedby="principal-change-context" onClick={execute}>Apply change</button>
      </div>
    </section> : <form onSubmit={event => { event.preventDefault(); if (ready) prepareReview() }}>
      <label>Change<select ref={actionSelect} aria-label="Change" disabled={busy} value={action} onChange={event => setAction(event.target.value as Change['action'])}>
        {choices.map(value => <option key={value} value={value}>{server && value === 'create' ? 'Create server role'
          : (mysql ? mysqlLabels[value] : tsql ? sqlServerLabels[value] : oracle ? oracleLabels[value] : undefined) ?? actions[value]}</option>)}
      </select></label>
      {!create && <p>{role ? <>Selected principal <strong>{role.name}</strong></> : 'Inspect a principal first to use it in a reviewed change.'}</p>}
      {unsupported && <p>{unsupportedOracle ? 'Inspect an Oracle user to change the account lock.' : membership
        ? 'Inspect a MariaDB role to change its membership.' : 'This action requires a MariaDB user account.'}</p>}
      {(tsql || oracle) && membership && role && !role.canGrantMembership && <p>Inspect a role to change its membership.</p>}
      {server && engine === 'azure-sql' && <p>Azure SQL uses predefined server roles. Login removal requires a separate cross-database review.</p>}
      {needsName && <div className="principals-fields">
        <label>{nameLabel}<input disabled={busy} value={name} maxLength={255}
          onChange={event => setName(event.target.value)} /></label>
        {needsHost && <label>New account host<input disabled={busy} value={host} maxLength={255}
          onChange={event => setHost(event.target.value)} /></label>}
      </div>}
      {action === 'create-mapped-user' && <label>Existing login name<input disabled={busy} value={login} maxLength={128}
        onChange={event => setLogin(event.target.value)} /></label>}
      {membership && <div className="principals-fields">
        <label>{mysql ? 'Member account or role name' : tsql || oracle ? 'Member principal name' : 'Member role name'}<input disabled={busy || !role} value={member} maxLength={255}
          onChange={event => setMember(event.target.value)} /></label>
        {mysql && <label>Member host{engine === 'mariadb' ? ' (blank for a role)' : ''}<input disabled={busy || !role}
          value={memberHost} maxLength={255} onChange={event => setMemberHost(event.target.value)} /></label>}
      </div>}
      {relationChange && <>
        <p>{relation ? `${relation.schema}.${relation.name}` : 'Inspect a visible relation before reviewing its grants.'}</p>
        <label>Privilege<select aria-label="Privilege" disabled={busy || !relation} value={privilege} onChange={event => setPrivilege(event.target.value)}>
          {(mysql ? mysqlRelationPrivileges : tsql ? sqlServerRelationPrivileges : oracle ? oracleRelationPrivileges : relationPrivileges).map(value => <option key={value}>{value}</option>)}
        </select></label>
      </>}
      <button className="primary-button" type="submit" disabled={busy || !ready}>Review change</button>
    </form>}
    {busy && <p role="status">{stage}</p>}
    {error && <p role="alert" tabIndex={-1} ref={errorNotice}>{error}</p>}
  </div>
}
