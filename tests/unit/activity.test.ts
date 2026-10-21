import { describe,it,expect } from 'vitest'
import { activityQueries } from '../../src/activity/queries'
import { readActivity,localActivity } from '../../src/activity/read'
import { activityRequestSchema,activitySnapshotSchema } from '../../src/shared/activity'
import { engineSchema,type SessionInfo } from '../../src/shared/contracts'

describe('session and lock inspection',()=>{
  it.each(engineSchema.options.filter(e=>!['sqlite','duckdb'].includes(e)))('uses bounded fixed read-only catalog SQL and excludes query text by default for %s',engine=>{
    const plan=activityQueries(engine,false),withSql=activityQueries(engine,true)
    for(const key of ['sessions','locks','waits'] as const){expect(plan[key]).toMatch(/^SELECT/i);expect(plan[key]).toMatch(/201|501/);expect(plan[key]).not.toMatch(/\b(?:KILL|UPDATE|DELETE|INSERT|ALTER|GRANT)\b/)}
    expect(plan.sessions).not.toMatch(/(?:LEFT|SUBSTR)\((?:query|INFO|txt.text|q.SQL_TEXT)/i);expect(withSql.sessions).toContain('4001')
  })
  it('rejects arbitrary SQL, unbounded exports and malformed requests',()=>{
    expect(activityRequestSchema.safeParse({sessionId:'id',includeSql:true,sql:'KILL 1'}).success).toBe(false)
    expect(activityRequestSchema.safeParse({sessionId:'id',includeSql:'true'}).success).toBe(false)
    expect(activitySnapshotSchema.safeParse({engine:'postgres',sessions:{rows:Array(201).fill({})}}).success).toBe(false)
  })
  it('keeps permission failures separate from empty results',async()=>{
    let n=0;const result=await readActivity('postgres','db','12',async()=>{if(++n===2)throw Object.assign(new Error('permission denied'),{code:'42501'});return []},false)
    expect(result.sessions.status).toBe('available');expect(result.locks.status).toBe('unavailable');expect(result.locks.notice).toContain('42501');expect(result.waits.status).toBe('available')
  })
  it('bounds rows and fields and drops SQL even if a transport unexpectedly supplies it',async()=>{
    const row=['123','u','db','app','host','active','SELECT','1','tx','start','wait','x'.repeat(5000)]
    let n=0;const run=async()=>++n===1?Array(201).fill(row):[]
    const hidden=await readActivity('postgres','db','12',run,false);expect(hidden.sessions.rows).toHaveLength(200);expect(hidden.sessions.truncated).toBe(true);expect(hidden.sessions.rows[0].query).toBeNull()
    expect(activitySnapshotSchema.safeParse({...hidden,sessions:{...hidden.sessions,status:'unavailable'}}).success).toBe(false)
    expect(activitySnapshotSchema.safeParse({...hidden,sessions:{...hidden.sessions,rows:[{...hidden.sessions.rows[0],query:'secret'}]}}).success).toBe(false)
    n=0;const shown=await readActivity('postgres','db','12',run,true);expect(shown.sessions.rows[0].query).toHaveLength(4000);expect(shown.sessions.rows[0].queryTruncated).toBe(true)
  })
  it.each(['sqlite','duckdb'] as const)('reports local state without inventing %s lock owners',engine=>{
    const info={id:'local',engine,name:'connection',database:'db',host:'/tmp/db',transaction:'transaction'} as SessionInfo
    const result=localActivity(engine,info,[{info,busy:true}],true)
    expect(result.sessions.rows[0]).toMatchObject({id:'local',state:'Running operation',transaction:'transaction',query:null});expect(result.locks.status).toBe('unsupported');expect(result.waits.status).toBe('unsupported')
  })
})
