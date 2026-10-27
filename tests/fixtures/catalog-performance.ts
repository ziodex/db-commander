import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig } from '../../src/shared/contracts'
import { spawnSync } from 'node:child_process'

export const PERFORMANCE_CATALOG_SIZES = [10000, 20000] as const
export const performanceTable = (index: number, prefix='perf_') => `${prefix}${String(index).padStart(5, '0')}`
/** A settled snapshot, not a peak; include native workers owned by this driver. */
export function catalogProcessMemory(rootPid=process.pid) {
  if (process.platform==='win32') return {scope:'runner only',rssBytes:process.memoryUsage().rss,pids:[process.pid]}
  const result=spawnSync('ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'})
  if(result.status!==0) throw new Error('Cannot measure the owned catalog process tree.')
  const rows=result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([pid]) => pid!==result.pid)
  if(!rows.some(([pid])=>pid===rootPid)||rows.some(row=>row.length!==3||row.some(value=>!Number.isFinite(value))))throw new Error('Incomplete catalog process memory snapshot.')
  const owned=new Set([rootPid])
  let previous=0
  while(owned.size!==previous) {previous=owned.size;for(const [pid,parent] of rows)if(owned.has(parent))owned.add(pid)}
  return {scope:'driver and complete owned POSIX process tree',rssBytes:rows.filter(([pid]) => owned.has(pid)).reduce((sum,[,,rss])=>sum+rss*1024,0),pids:[...owned]}
}
/** Empty constrained tables: large metadata without generating application data. */
export function performanceCatalogSeed(engine: ConnectionConfig['engine'], start: number, end: number, prefix='perf_') {
  const q = (name: string) => quoteIdentifier(name, engine)
  return Array.from({length:end-start},(_,offset) => {
    const name=q(performanceTable(start+offset,prefix))
    return `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, label VARCHAR(80) NOT NULL UNIQUE, other_label VARCHAR(80) UNIQUE, parent_id INTEGER, amount INTEGER CHECK(amount >= 0), flag SMALLINT, created_at VARCHAR(40), note VARCHAR(80) DEFAULT 'fixture', FOREIGN KEY(parent_id) REFERENCES ${name}(id));`
  }).join('\n')
}
