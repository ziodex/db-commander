import { PrincipalChangeEditor } from './PrincipalChangeEditor'
import type { ApplyPrincipalChange, PreparePrincipalChange, PrincipalChangeResult, PrincipalChangeReview } from '../shared/principal-changes'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { PRINCIPAL_LIMIT, previewPrincipalChange, previewMysqlPrincipalChange, previewSqlServerPrincipalChange, previewOraclePrincipalChange, mysqlRelationPrivileges, sqlServerRelationPrivileges, oracleRelationPrivileges, relationPrivileges, type RelationPrivilege, type NamedPrincipalChange, type PrincipalScope, type PrincipalPrivilege, type PrincipalRequest, type PrincipalSnapshot } from '../shared/principals'
import { engineNames } from '../shared/database-engines'
import type { SessionInfo } from '../shared/contracts'
import { rendererError } from './workspace-runtime'

type Roles = Extract<PrincipalSnapshot, { mode: 'roles' }>
type Role = Extract<PrincipalSnapshot, { mode: 'role' }>

function Privileges({ heading, description, values }: { heading: string; description?: string; values: PrincipalPrivilege[] }) {
  return <div className="activity-table"><table aria-labelledby={heading} aria-describedby={description}>
    <thead><tr><th scope="col">Privilege</th><th scope="col">Effective</th><th scope="col">Grant option</th></tr></thead>
    <tbody>{values.map(value => <tr key={value.privilege}><th scope="row">{value.privilege}</th><td>{value.effective ? 'Yes' : 'No'}</td><td>{value.grantable ? 'Yes' : 'No'}</td></tr>)}</tbody>
  </table></div>
}

function Memberships({ detail }: { detail: Role }) {
  return <>
    <details className="activity-detail"><summary>Direct membership grants ({detail.direct.rows.length}{detail.direct.truncated ? '+' : ''})</summary>
      {detail.direct.rows.length ? <ul>{detail.direct.rows.map(edge => <li key={JSON.stringify([edge.role, edge.member, edge.grantor])}>
        <strong>{edge.role}</strong> granted to <strong>{edge.member}</strong>{edge.grantor && <> by {edge.grantor}</>}
        <small>{edge.admin !== null && ` · Admin ${edge.admin ? 'yes' : 'no'}`}{edge.inherit !== null && ` · Inherit ${edge.inherit ? 'yes' : 'no'}`}{edge.set !== null && ` · Set role ${edge.set ? 'yes' : 'no'}`}</small>
      </li>)}</ul> : <p>No direct membership grants returned.</p>}
    </details>
    <details className="activity-detail"><summary>Role memberships ({detail.memberships.rows.length}{detail.memberships.truncated ? '+' : ''})</summary>
      <p>{detail.catalog
        ? detail.catalog.membershipNotice ?? 'Includes visible direct and inherited memberships. Availability depends on which roles are enabled in the session.'
        : 'Includes direct and indirect memberships. PostgreSQL reports whether their privileges are available immediately. Superusers are treated as members of all roles.'}</p>
      {detail.memberships.rows.length ? <ul>{detail.memberships.rows.map(value => <li key={value.role}>{value.role} · {value.usable === null ? 'Activation not evaluated' : value.usable ? 'Available now' : 'Unavailable now'}</li>)}</ul> : <p>No role memberships returned.</p>}
    </details>
  </>
}

function CatalogGrants({ detail }: { detail: Role }) {
  const catalog = detail.catalog!
  return <>
    {catalog.enabled && <details className="activity-detail">
      <summary>{catalog.enabledLabel ?? 'Enabled roles on the catalog connection'} ({catalog.enabled.rows.length}{catalog.enabled.truncated ? '+' : ''})</summary>
      <p>This is a separate connection. The query tab can have different roles or security context.</p>
      {catalog.enabled.rows.length ? <ul>{catalog.enabled.rows.map(role => <li key={role}>{role}</li>)}</ul> : <p>No roles are enabled on the catalog connection.</p>}
    </details>}
    {catalog.relation === null && <p role="status">The relation was missing or outside the catalog connection’s visible scope.</p>}
    <h4 id="principal-catalog-grants">Visible privilege grants<span className="sr-only"> for {detail.role.name}</span></h4>
    <p>{catalog.grantNotice ?? 'This shows direct grants and table grants through visible role memberships. Role activation, database grant patterns and server restrictions can change effective access.'}</p>
    {catalog.grants.rows.length ? <div className="activity-table"><table className="principal-grant-table" aria-labelledby="principal-catalog-grants">
      <thead><tr><th scope="col">Privilege</th><th scope="col">Scope and source</th><th scope="col">Grant option</th></tr></thead>
      <tbody>{catalog.grants.rows.map(grant => <tr key={JSON.stringify(grant)}>
        <th scope="row">{grant.privilege}{grant.effect && <small>{grant.effect.replaceAll('_', ' ')}</small>}</th><td>{grant.scope}
          <small>{grant.via ? `${grant.via} · ${grant.enabled ? 'Enabled on this catalog connection' : 'Role membership'}` : 'Direct'}</small></td><td>{grant.grantable === null ? '—' : grant.grantable ? 'Yes' : 'No'}</td>
      </tr>)}</tbody>
    </table></div> : <p>No visible privilege grants were returned.</p>}
    {catalog.grants.truncated && <p>Showing the first {PRINCIPAL_LIMIT} privilege entries.</p>}
    {catalog.effective && <details className="activity-detail">
      <summary>Effective privileges on the catalog connection ({catalog.effective.rows.length}{catalog.effective.truncated ? '+' : ''})</summary>
      <p>The server evaluated these privileges for this connection’s security context.</p>
      {catalog.effective.rows.length ? <ul>{catalog.effective.rows.map(grant => <li key={JSON.stringify(grant)}>{grant.privilege} · {grant.scope}</li>)}</ul>
        : <p>No effective privileges were returned for this scope.</p>}
    </details>}
  </>
}

export function SecurityPrincipalsDialog({ session, opener, load, prepare, apply, onClose }: {
  session: SessionInfo
  opener: HTMLElement
  load(request: PrincipalRequest): Promise<PrincipalSnapshot>
  prepare(request: PreparePrincipalChange): Promise<PrincipalChangeReview>
  apply(request: ApplyPrincipalChange): Promise<PrincipalChangeResult>
  onClose(): void
}) {
  const engineName = engineNames[session.engine]
  const reviewTitle = session.engine === 'azure-sql' ? 'Review Azure SQL statement' : `Review ${engineName} SQL`
  const mysql = session.engine === 'mysql' || session.engine === 'mariadb' ? session.engine : undefined
  const tsql = session.engine === 'sqlserver' || session.engine === 'azure-sql' ? session.engine : undefined
  const oracle = session.engine === 'oracle'
  const catalogEngine = mysql || tsql || oracle
  const [scope, setScope] = useState<PrincipalScope>('database')
  const serverScope = tsql && scope === 'server'
  const principalLabel = mysql ? 'Account or role' : tsql ? serverScope ? 'Server principal' : 'Database principal' : oracle ? 'User or role' : 'Role'
  const dialog = useRef<HTMLDialogElement>(null), detailHeading = useRef<HTMLHeadingElement>(null), reviewHeading = useRef<HTMLHeadingElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null), returningToInspect = useRef(false)
  const mounted = useRef(false), pending = useRef(false)
  const [roles, setRoles] = useState<Roles>(), [detail, setDetail] = useState<Role>()
  const [search, setSearch] = useState(''), [selected, setSelected] = useState('')
  const [schema, setSchema] = useState(''), [table, setTable] = useState('')
  const [action, setAction] = useState<NamedPrincipalChange['action']>('create'), [name, setName] = useState(''), [member, setMember] = useState('')
  const [host, setHost] = useState('%'), [memberHost, setMemberHost] = useState('')
  const [sql, setSql] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const [privilege, setPrivilege] = useState<string>('SELECT')
  const [view, setView] = useState<'inspect' | 'preview' | 'change'>('inspect')

  async function work(action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setMessage('')
    try { await action() }
    catch (cause) { if (mounted.current) setError(rendererError(cause)) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }

  function findRoles(selectedScope = scope) {
    return work(async () => {
      setRoles(undefined); setSelected(''); setMember(''); setDetail(undefined); setSql(''); setSchema(''); setTable('')
      const result = await load({ mode: 'roles', sessionId: session.id, search, scope: tsql ? selectedScope : undefined })
      if (mounted.current && result.mode === 'roles') setRoles(result)
    })
  }

  function inspect() {
    return work(async () => {
      setDetail(undefined); setSql('')
      const relation = schema && table ? { schema, name: table } : undefined
      const result = await load({ mode: 'role', sessionId: session.id, roleId: selected, relation, scope: tsql ? scope : undefined })
      if (mounted.current && result.mode === 'role') setDetail(result)
    })
  }

  const relationChange = action === 'grant-relation' || action === 'revoke-relation'
  const target = detail?.relation?.target ?? detail?.catalog?.relation
  const canReview = action === 'create' ? Boolean(name.trim() && !(tsql === 'azure-sql' && serverScope)) : relationChange ? Boolean(target)
    : Boolean(detail && member.trim() && (mysql !== 'mysql' || memberHost) && !(mysql === 'mariadb' && detail.role.account?.host) && (!(tsql || oracle) || detail.role.canGrantMembership))
  function review() {
    setSql(''); setError(''); setMessage('')
    try {
      if (mysql) {
        if (action === 'create') setSql(previewMysqlPrincipalChange(mysql, { action, role: { user: name, host: mysql === 'mysql' ? host : '' } }))
        else if (detail?.role.account) {
          const role = detail.role.account
          if (relationChange && target) setSql(previewMysqlPrincipalChange(mysql, { action, role, relation: target, privilege }))
          if (action === 'grant' || action === 'revoke') setSql(previewMysqlPrincipalChange(mysql, { action, role, member: { user: member, host: memberHost } }))
        }
      } else if (tsql) {
        if (action === 'create') setSql(previewSqlServerPrincipalChange(tsql, scope, { action, name }))
        else if (detail) {
          const role = detail.role.name
          if (relationChange && target) setSql(previewSqlServerPrincipalChange(tsql, scope, { action, role, relation: target, privilege }))
          if (action === 'grant' || action === 'revoke') setSql(previewSqlServerPrincipalChange(tsql, scope, { action, role, member }))
        }
      } else if (oracle) {
        if (action === 'create') setSql(previewOraclePrincipalChange({ action, name }))
        else if (detail) {
          const role = detail.role.name
          if (relationChange && target) setSql(previewOraclePrincipalChange({ action, role, relation: target, privilege }))
          if (action === 'grant' || action === 'revoke') setSql(previewOraclePrincipalChange({ action, role, member }))
        }
      } else if (action === 'create') {
        setSql(previewPrincipalChange({ action, name }))
      } else if (relationChange && detail?.relation) {
        setSql(previewPrincipalChange({ action, role: detail.role.name, relation: detail.relation.target, privilege: privilege as RelationPrivilege }))
      } else if (action === 'grant' || action === 'revoke') {
        if (detail) setSql(previewPrincipalChange({ action, role: detail.role.name, member }))
      }
    } catch (cause) { setError(rendererError(cause)) }
  }

  const initial = useEffectEvent(() => { void findRoles() })
  useEffect(() => {
    const node = dialog.current!
    mounted.current = true
    node.showModal(); initial()
    return () => { mounted.current = false; node.close() }
  }, [])
  useEffect(() => { if (detail && !busy && view === 'inspect') detailHeading.current?.focus() }, [detail, busy, view])
  useEffect(() => { if (sql) reviewHeading.current?.focus() }, [sql])
  useEffect(() => {
    if (returningToInspect.current && view === 'inspect' && !busy) {
      returningToInspect.current = false
      searchInput.current?.focus()
    }
  }, [view, busy])

  function switchView(next: typeof view) {
    if (next === view) return
    setView(next); setError(''); setMessage('')
    content.current?.scrollTo({ top: 0 })
  }

  function dismiss() {
    if (pending.current && view === 'change') return
    dialog.current?.close()
    if (opener.isConnected) opener.focus()
    onClose()
  }

  const selection = roles?.roles.rows ?? []
  const canInspect = Boolean(selected) && (Boolean(serverScope) || Boolean(schema) === Boolean(table))
  const attributes = !catalogEngine && detail && [
    detail.role.login ? 'Can log in' : 'No login', detail.role.inherit ? 'Role inheritance enabled by default' : 'Role inheritance disabled by default',
    detail.role.superuser && 'Superuser', detail.role.createRole && 'Create role', detail.role.createDatabase && 'Create database',
    detail.role.replication && 'Replication', detail.role.bypassRls && 'Bypass row security'
  ].filter(Boolean)
  return <dialog ref={dialog} className="connection-dialog activity-dialog principals-dialog" aria-labelledby="security-principals-title"
    onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); dismiss() }}>
    <header className="principals-header">
      <div className="dialog-heading"><div><h2 id="security-principals-title">Security principals</h2>
        <p>{session.name} · {serverScope ? 'Server principals' : session.database} · {engineName}</p></div>
        <button aria-label="Close security principals" disabled={busy && view === 'change'} onClick={dismiss}>×</button></div>
      <div className="activity-views" role="group" aria-label="Security principal views">
        <button disabled={busy} aria-pressed={view === 'inspect'} onClick={() => switchView('inspect')}>{catalogEngine ? 'Inspect principals' : 'Inspect roles'}</button>
        <button disabled={busy} aria-pressed={view === 'preview'} onClick={() => switchView('preview')}>SQL preview</button>
        {(session.engine === 'postgres' || catalogEngine) && <button disabled={busy} aria-pressed={view === 'change'} onClick={() => switchView('change')}>Apply changes</button>}
        {view === 'inspect' && detail && <span>{catalogEngine ? 'Inspected principal' : 'Inspected role'} <strong>{detail.role.name}</strong></span>}
      </div>
    </header>
    <div ref={content} className="principals-content">
      {view !== 'change' && <p>Inspect {engineName} {mysql ? 'accounts and roles' : tsql ? 'users, logins and roles' : oracle ? 'users and roles' : 'roles'} and preview changes for manual execution.</p>}
      {view === 'inspect' && busy && <p role="status">Reading {engineName} catalog…</p>}
      {view === 'inspect' && error && <p role="alert">{error}</p>}
      {view === 'inspect' ? <>
        {tsql && <label>Principal scope<select aria-label="Principal scope" disabled={busy} value={scope} onChange={event => {
          const next = event.target.value as PrincipalScope
          setScope(next)
          if (next === 'server') setAction('grant')
          void findRoles(next)
        }}>
          <option value="database">Current database</option><option value="server">Server</option>
        </select></label>}
        <form className="principals-fields" onSubmit={event => { event.preventDefault(); void findRoles() }}>
          <label>{mysql ? 'Account or role search' : tsql || oracle ? 'Principal name search' : 'Role name search'}<input ref={searchInput} disabled={busy} value={search} maxLength={255} onChange={event => setSearch(event.target.value)} /></label>
          <button disabled={busy} type="submit">{catalogEngine ? 'Search principals' : 'Search roles'}</button>
        </form>
        {roles && <>
          {roles.notice && <p>{roles.notice}</p>}
          <p>{roles.roles.rows.length} {catalogEngine ? 'principal' : 'role'}{roles.roles.rows.length === 1 ? '' : 's'} returned{roles.roles.truncated && ` · Showing the first ${PRINCIPAL_LIMIT}. Narrow your search for more results.`}</p>
          {selection.length > 0 && <form onSubmit={event => { event.preventDefault(); void inspect() }}>
            <label>{principalLabel}<select aria-label={principalLabel} disabled={busy} value={selected} onChange={event => { setSelected(event.target.value); setDetail(undefined); setSql('') }}>
              <option value="">Choose {mysql ? "an account or role" : tsql || oracle ? "a principal" : "a role"}</option>
              {selection.map(role => <option key={role.id} value={role.id}>{role.name}{role.description ? ` · ${role.description}` : role.login ? ' · login' : ''}</option>)}
            </select></label>
            {!serverScope && <>
            <div className="principals-fields">
              <label>{mysql ? 'Database for relation check' : 'Schema for relation check'}<input disabled={busy} value={schema} maxLength={255} onChange={event => { setSchema(event.target.value); setDetail(undefined); setSql('') }} /></label>
              <label>Table or view name<input disabled={busy} value={table} maxLength={255} onChange={event => { setTable(event.target.value); setDetail(undefined); setSql('') }} /></label>
            </div>
            <p>Leave both fields blank for principal and database access only. Use exact names for a table or view.</p>
            </>}
            <button className="primary-button" type="submit" disabled={busy || !canInspect}>{catalogEngine ? 'Inspect selected principal' : 'Inspect selected role'}</button>
          </form>}
        </>}
        {detail && <section className="activity-detail" aria-labelledby="selected-principal">
          <h3 ref={detailHeading} id="selected-principal" tabIndex={-1}>{detail.role.name}</h3>
          {detail.role.description && <p>{detail.role.description}</p>}
          {attributes && <p>{attributes.join(' · ')}</p>}
          {detail.notice && <p>{detail.notice}</p>}
          <p>Database {detail.database} · Catalog connection as {detail.observer}</p>
          <Memberships detail={detail} />
          {detail.catalog ? <CatalogGrants detail={detail} /> : <>
          <h4 id="principal-database-privileges">Effective database privileges<span className="sr-only"> for {detail.role.name}</span></h4>
          <Privileges heading="principal-database-privileges" values={detail.databasePrivileges} />
          {detail.relation === null && <p role="status">The relation was missing or outside the catalog connection’s visible scope.</p>}
          {detail.relation && <>
            <h4 id="principal-relation-privileges">Effective relation privileges<span className="sr-only"> for {detail.role.name}</span></h4>
            <p>{detail.relation.target.schema}.{detail.relation.target.name} · Owner {detail.relation.owner} · Schema usage {detail.relation.schemaUsage ? 'yes' : 'no'} · Row security {detail.relation.rowSecurity ? 'enabled' : 'disabled'}</p>
            <p id="principal-relation-scope">Effective reflects table-level privileges. Schema access and row policies are evaluated separately.</p>
            <Privileges heading="principal-relation-privileges" description="principal-relation-scope" values={detail.relation.privileges} />
            <details className="activity-detail"><summary>Explicit grants to the role or PUBLIC ({detail.relation.grants.rows.length}{detail.relation.grants.truncated ? '+' : ''})</summary>
              {detail.relation.grants.rows.length ? <ul>{detail.relation.grants.rows.map(grant => <li key={JSON.stringify(grant)}>{grant.privilege} to {grant.grantee} by {grant.grantor}{grant.grantable ? ' · grant option' : ''}</li>)}</ul>
                : <p>No explicit relation grants to this role or PUBLIC returned. Ownership, defaults and other roles can still confer access.</p>}
            </details>
          </>}
          </>}
        </section>}
        <details className="activity-detail"><summary>Visibility and limits</summary>
          <p>{mysql ? 'Accounts and roles are server-wide.' : tsql ? 'Server logins and roles are separate from database users and roles.' : oracle ? 'Oracle users and roles are inspected in the current container.' : 'Roles are cluster-wide.'} Database and relation checks use a separate catalog connection{roles && <> as <strong>{roles.observer}</strong> in <strong>{roles.database}</strong></>}. Session role changes and temporary objects are outside its scope.</p>
          {tsql || oracle ? <p>Grants and role memberships follow the server’s metadata visibility rules. Effective privileges apply to the catalog connection’s own security context.</p> : mysql ? <p>Privilege entries depend on grant catalog visibility. Role activation is shown for the connected account on the catalog connection. Column grants, role activation on other sessions and effective access for other accounts are outside this view.</p> : <p>Privilege checks include inheritance and ownership as PostgreSQL reports them. Relation results cover the displayed table-level privileges. Column privileges, row policies and runtime conditions can change what a statement can do. Each role list, membership list and grant list is capped at {PRINCIPAL_LIMIT} rows.</p>}
        </details>
      </> : view === 'change' ? <PrincipalChangeEditor session={session} scope={scope} role={detail?.role} relation={detail?.relation?.target ?? detail?.catalog?.relation ?? undefined}
        busy={busy} error={error} work={work}
        prepare={change => prepare({ sessionId: session.id, change })}
        apply={request => apply({ sessionId: session.id, ...request })}
        invalidate={() => { setRoles(undefined); setSelected(''); setDetail(undefined); setSql('') }}
        refresh={() => { returningToInspect.current = true; switchView('inspect'); void findRoles() }} /> : <form onSubmit={event => { event.preventDefault(); review() }}>
        <label>Change<select aria-label="Change" disabled={busy} value={action} onChange={event => { setAction(event.target.value as NamedPrincipalChange['action']); setSql('') }}>
          {!(tsql === "azure-sql" && serverScope) && <option value="create">{catalogEngine ? serverScope ? "Create server role" : "Create role" : "Create role without login"}</option>}<option value="grant">Grant role membership</option><option value="revoke">Revoke role membership</option>
          {!serverScope && <><option value="grant-relation">Grant relation privilege</option><option value="revoke-relation">Revoke relation privilege</option></>}
        </select></label>
        {action === 'create' ? <>
          <label>New role name<input disabled={busy} value={name} maxLength={tsql || oracle || mysql === 'mariadb' ? 128 : 63} onChange={event => { setName(event.target.value); setSql('') }} /></label>
          {mysql === 'mysql' && <label>New role host<input disabled={busy} value={host} maxLength={255} onChange={event => { setHost(event.target.value); setSql('') }} /></label>}
        </> : relationChange ? <>
          <p>{detail && target ? `${detail.role.name} · ${target.schema}.${target.name}` : 'Inspect a principal and a visible relation to use them in the preview.'}</p>
          <label>Privilege<select aria-label="Privilege" disabled={busy || !target} value={privilege} onChange={event => { setPrivilege(event.target.value); setSql('') }}>
            {(mysql ? mysqlRelationPrivileges : tsql ? sqlServerRelationPrivileges : oracle ? oracleRelationPrivileges : relationPrivileges).map(value => <option key={value}>{value}</option>)}
          </select></label>
        </> : <>
          <p>{detail ? `Selected role ${detail.role.name}` : 'Inspect a role to use it in the preview.'}</p>
          {(tsql || oracle) && detail && !detail.role.canGrantMembership && <p>Inspect a role that supports membership changes.</p>}
          {mysql === 'mariadb' && detail?.role.account?.host && <p>Inspect a MariaDB role to grant or revoke membership in it.</p>}
          <label>{mysql ? 'Member account or role name' : tsql || oracle ? 'Member principal name' : 'Member role name'}<input disabled={busy || !detail} value={member} maxLength={catalogEngine ? 128 : 63} onChange={event => { setMember(event.target.value); setSql('') }} /></label>
          {mysql && <label>Member host<input disabled={busy || !detail} value={memberHost} maxLength={255} onChange={event => { setMemberHost(event.target.value); setSql('') }} /></label>}
          <p>{mysql === 'mysql' ? 'Enter the member’s exact name and host.' : mysql === 'mariadb' ? 'Enter the exact name and host for a member account. Leave the host blank for a member role.' : tsql || oracle ? 'Enter an existing member name in the selected principal scope.' : 'Enter the exact name of the existing role that will receive or lose membership.'}</p>
        </>}
        <button className="primary-button" type="submit" disabled={busy || !canReview}>Review SQL</button>
        {error && !sql && <p role="alert">{error}</p>}
        {sql && <section className="activity-detail" aria-labelledby="principal-sql-heading">
          <h3 id="principal-sql-heading" ref={reviewHeading} tabIndex={-1}>{reviewTitle}</h3>
          <p>Run this SQL manually on the intended {engineName} connection{serverScope && tsql === 'azure-sql' ? ' in master' : ''}. Verify current role names, grants and permissions first.</p>
          {action === 'grant' && <p>{mysql || oracle ? 'The role must be enabled for its privileges to apply to a session.' : tsql ? 'Membership can confer permissions or denials through the selected role.' : 'Membership can confer inherited privileges or allow SET ROLE. PostgreSQL applies its default membership options.'}</p>}
          {(action === 'revoke' || action === 'revoke-relation') && <p>{tsql && action === 'revoke-relation' ? 'REVOKE clears a grant or denial. Removing a denial can restore access through another grant.' : 'Revocation can remove access. Other grant paths can keep membership or privileges in effect.'}</p>}
          <textarea aria-label="Security principal SQL" value={sql} readOnly spellCheck={false} />
          <div className="principals-copy">
            <button type="button" aria-disabled={busy} onClick={() => void work(async () => { await window.dbCommander.copyDefinition(sql); if (mounted.current) setMessage('SQL copied.') })}>Copy SQL</button>
            <span role="status">{busy ? 'Copying SQL…' : message}</span>
          </div>
          {error && <p role="alert">{error}</p>}
        </section>}
      </form>}
    </div>
  </dialog>
}
