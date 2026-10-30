import { useEffect, useRef } from 'react'
import type { BackupInspection } from '../shared/backup'

export function BackupChecks({ inspection }: { inspection: BackupInspection }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (!inspection.ready) heading.current?.focus() }, [inspection])
  return <section aria-label="Backup checks" className="backup-checks">
    <h3 ref={heading} tabIndex={-1}>{inspection.ready ? 'Requirements checked' : 'Resolve these checks before continuing'}</h3>
    <p>Checked {new Date(inspection.checkedAt).toLocaleTimeString()}. These checks do not create or restore a database. The job checks its requirements again before making changes.</p>
    <ul>{inspection.checks.map((item, index) => <li key={index} data-status={item.status}><strong>{item.label}: {item.status === 'passed' ? 'Passed' : item.status === 'warning' ? 'Review note' : 'Needs attention'}</strong>{item.status !== 'passed' && <p>{item.detail}</p>}</li>)}</ul>
    {!!inspection.metadata.length && <dl>{inspection.metadata.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
  </section>
}
