import { describe,it,expect } from 'vitest'
import { captureRollback,refreshRollback,RollbackInspections } from '../../src/activity/rollback'
import { rollbackRequestSchema } from '../../src/shared/rollback'
import type { ActivityObserver } from '../../src/activity/control'
import type { Cell,DatabaseEngine,SessionInfo } from '../../src/shared/contracts'
const session=(engine:DatabaseEngine)=>({id:'source',engine,database:'db',name:'Monitor'} as SessionInfo)
function fixture(engine:DatabaseEngine,results:(Cell[][]|Error)[]) {
  const sql:string[]=[],observer:ActivityObserver={engine,database:'db',currentSessionId:'456',query:async text=>{sql.push(text);const result=results.shift()??[];if(result instanceof Error)throw result;return result}}
  return {observer,sql}
}
describe('rollback progress inspection',()=>{
  it('accepts exactly one start or refresh target, never renderer SQL or identity',()=>{
    for(const request of [{sessionId:'00000000-0000-0000-0000-000000000000',targetId:'1',sql:'KILL 1'},{sessionId:'00000000-0000-0000-0000-000000000000',targetId:'1',inspectionId:'11111111-1111-4111-8111-111111111111'},{sessionId:'00000000-0000-0000-0000-000000000000'},{sessionId:'00000000-0000-0000-0000-000000000000',inspectionId:'11111111-1111-4111-8111-111111111111',transaction:'123'}])expect(rollbackRequestSchema.safeParse(request).success).toBe(false)
    expect(rollbackRequestSchema.parse({sessionId:'00000000-0000-0000-0000-000000000000',targetId:'1'})).toEqual({sessionId:'00000000-0000-0000-0000-000000000000',targetId:'1'})
  })
  it.each(['postgres','mysql','mariadb','sqlserver','azure-sql','oracle'] as const)('uses bounded, read-only %s diagnostics without SQL text',async engine=>{
    const f=fixture(engine,[[['1','123','tx','start']],[['ACTIVE','1','2','3']],[]])
    await captureRollback(f.observer,session(engine),engine==='oracle'?'1:123':'123',1)
    expect(f.sql.length).toBeGreaterThan(0)
    for(const sql of f.sql){expect(sql).toMatch(/^SELECT/);expect(sql).not.toMatch(/\bKILL\b|ALTER SYSTEM|SQL_TEXT|TRX_QUERY|SELECT query,/i)}
  })
  it('rejects malformed native IDs before any database read',async()=>{
    const f=fixture('mysql',[])
    for(const id of ['0','-1','1; KILL 2','1:2','18446744073709551616'])await expect(captureRollback(f.observer,session('mysql'),id,1)).rejects.toThrow()
    expect(f.sql).toHaveLength(0)
  })
  it.each(['sqlite','duckdb'] as const)('makes %s unsupported without probing its query connection',async engine=>{
    const f=fixture(engine,[]),r=await captureRollback(f.observer,session(engine),'local',1)
    expect(r.snapshot).toMatchObject({status:'unsupported',percent:null,metrics:[]});expect(f.sql).toHaveLength(0)
  })
  it('captures immutable InnoDB transaction identity and never retargets a reused connection ID',async()=>{
    const f=fixture('mysql',[[['55','123','999','2026-10-14 10:00:00']],[['RUNNING',null,'999999999999999999','2']],[['ROLLING BACK','rollback','55','1']],[]])
    const store=new RollbackInspections(()=>1),first=await store.capture(f.observer,session('mysql'),'123')
    first.identity[2]='attacker';first.targetId='777'
    const rolling=await store.inspect(f.observer,session('mysql'),first.id)
    expect(rolling).toMatchObject({status:'rolling-back',percent:null,identity:['55','123','999','2026-10-14 10:00:00']})
    expect(rolling.metrics).toContainEqual({label:'Rows modified (reported)',value:'55'})
    expect(f.sql.at(-1)).toContain("TRX_ID AS CHAR)='999'");expect(f.sql.at(-1)).not.toContain('TRX_MYSQL_THREAD_ID')
    expect((await store.inspect(f.observer,session('mysql'),first.id)).status).toBe('not-visible')
  })
  it('does not infer PostgreSQL rollback progress from a failed/idle transaction',async()=>{
    const f=fixture('postgres',[[['backend','123','xact','xact']],[['idle in transaction (aborted)',null,null]]]),r=await captureRollback(f.observer,session('postgres'),'123',1)
    expect(r.snapshot).toMatchObject({status:'observed',percent:null});expect(f.sql[1]).toContain("backend_start::text='backend'");expect(f.sql[1]).toContain("xact_start::text='xact'")
  })
  it('reports only native TDS rollback percentages; unrelated work and malformed values have none',async()=>{
    for(const [state,command,pct,expected] of [['running','BACKUP DATABASE','70',null],['rollback','KILLED/ROLLBACK','0',0],['rollback','KILLED/ROLLBACK','42.5',42.5],['rollback','ROLLBACK','100',100],['rollback','ROLLBACK','101',null],['rollback','ROLLBACK','NaN',null],['rollback','ROLLBACK',null,null]] as const){
      const f=fixture('sqlserver',[[['login','uuid','9','begin']],[['7',state,command,pct]]]),r=await captureRollback(f.observer,session('sqlserver'),'123',1)
      expect(r.snapshot.percent).toBe(expected);expect(f.sql[1]).toContain("transaction_begin_time,126)='begin'");expect(f.sql[1]).toContain('transaction_id=a.transaction_id');expect(f.sql[1]).not.toContain('estimated_completion_time')
    }
  })
  it('reports Oracle undo usage separately from native parallel recovery counters',async()=>{
    const f=fixture('oracle',[[['7','logon','ABCD','12345']],[['ACTIVE','15','200']],[],[['ACTIVE','8','100']],[['RECOVERING','5','20']]])
    const c=await captureRollback(f.observer,session('oracle'),'1:123',1)
    expect(c.snapshot).toMatchObject({status:'observed',percent:null});expect(c.snapshot.metrics).toContainEqual({label:'Undo blocks used',value:'15'})
    const next=await refreshRollback(f.observer,c,2);expect(next).toMatchObject({status:'rolling-back',percent:25})
    expect(f.sql[1]).toContain("START_SCN)='12345'");expect(f.sql[2]).toContain("RAWTOHEX(XID)='ABCD'")
  })
  it('handles Oracle recovery after the session/ordinary transaction row disappears',async()=>{
    const f=fixture('oracle',[[['7','logon','ABCD','12345']],[],[['RECOVERING','0','0']],[],[['RECOVERED','20','20']]])
    const c=await captureRollback(f.observer,session('oracle'),'1:123',1);expect(c.snapshot).toMatchObject({status:'rolling-back',percent:null})
    const next=await refreshRollback(f.observer,c,2);expect(next.percent).toBe(100);expect(next.notices.join(' ')).toContain('not proof of global completion')
  })
  it('preserves Oracle undo observations when optional recovery privileges are missing',async()=>{
    const f=fixture('oracle',[[['7','logon','ABCD','12345']],[['ACTIVE','15','200']],new Error('denied'),[],new Error('denied')])
    const c=await captureRollback(f.observer,session('oracle'),'1:123',1)
    expect(c.snapshot.status).toBe('observed');expect(c.snapshot.notices.join(' ')).toContain('Parallel recovery diagnostics unavailable')
    expect((await refreshRollback(f.observer,c,2)).status).toBe('unavailable')
  })
  it('refuses ambiguous, hidden, oversized and changed session identities without later attaching to a transaction',async()=>{
    for(const rows of [[],[['1','123',null,null]],[['1','123','1','start'],['1','123','2','start']],[['x'.repeat(257),'123','1','start']]]){
      const f=fixture('mysql',[rows]),c=await captureRollback(f.observer,session('mysql'),'123',1)
      expect(c.snapshot.status).toBe('unavailable');expect(c.transaction).toEqual([])
      await refreshRollback(f.observer,c,2);expect(f.sql).toHaveLength(1)
    }
    const f=fixture('mysql',[[['1','123','9','start']]]),c=await captureRollback(f.observer,session('mysql'),'123',1,{id:'123',identity:['old','123'],user:'user',database:'db',client:'host',statement:null,transaction:'9'})
    expect(c.snapshot.status).toBe('unavailable');expect(f.sql).toHaveLength(1)
  })
  it('does not turn read failure into success or retain stale metrics',async()=>{
    const f=fixture('mysql',[[['1','123','9','start']],[['RUNNING',null,'99','2']],new Error('permission denied')]),c=await captureRollback(f.observer,session('mysql'),'123',1)
    const next=await refreshRollback(f.observer,c,2);expect(next).toMatchObject({status:'unavailable',metrics:[],percent:null});expect(next.notices.join(' ')).toContain('no session control is repeated')
  })
  it('binds captures to source, database, fixed expiry and replacement; disconnect forgets them',async()=>{
    let now=1;const f=fixture('postgres',[]),store=new RollbackInspections(()=>now),a=await store.capture(f.observer,session('postgres'),'123')
    await expect(store.inspect(f.observer,{...session('postgres'),id:'other'},a.id)).rejects.toThrow(/another/)
    await expect(store.inspect(f.observer,{...session('postgres'),database:'other'},a.id)).rejects.toThrow(/database/)
    now+=30*60_000;await expect(store.inspect(f.observer,session('postgres'),a.id)).rejects.toThrow(/expired/)
    const b=await store.capture(f.observer,session('postgres'),'123');await expect(store.inspect(f.observer,session('postgres'),a.id)).rejects.toThrow(/replaced/)
    store.forget('source');await expect(store.inspect(f.observer,session('postgres'),b.id)).rejects.toThrow()
  })
})
