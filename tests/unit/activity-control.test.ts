import { describe,it,expect } from 'vitest'
import { ActivityReviews, actionSql, dispatchAction, readTarget, sameTarget, type ActivityObserver, type ActivityTarget } from '../../src/activity/control'
import { activityControlLimit, prepareActivityActionSchema, applyActivityActionSchema } from '../../src/shared/activity-control'
import type { DatabaseEngine, SessionInfo } from '../../src/shared/contracts'
const target:ActivityTarget={id:'123',user:'alice',database:'db',client:'host',identity:['started','123'],statement:['query-start'],transaction:'tx'}
const session={id:'source',name:'Admin',engine:'postgres',database:'db'} as SessionInfo
describe('reviewed session controls',()=>{
  it('rejects renderer SQL, extra targets, missing acknowledgment and malformed IDs',()=>{
    expect(prepareActivityActionSchema.safeParse({sessionId:'source',targetId:'123',action:'terminate',sql:'KILL 1'}).success).toBe(false)
    expect(applyActivityActionSchema.safeParse({sessionId:'source',reviewId:'review',confirmation:'TERMINATE 123',acknowledge:false}).success).toBe(false)
    for(const id of ['0','-2','123; KILL 1','1:2','99999999999999999999999'])expect(()=>actionSql('postgres','terminate',{...target,id})).toThrow()
  })
  it('requires a statement identity and makes unsupported actions explicit',()=>{
    expect(()=>actionSql('postgres','cancel',{...target,statement:null})).toThrow(/active statement/)
    for(const engine of ['sqlite','duckdb','sqlserver','azure-sql'] as const)expect(activityControlLimit(engine,'cancel')).toBeTruthy()
    expect(()=>actionSql('duckdb','terminate',target)).toThrow(/owning tab/)
  })
  it('compares lifetime, principal, scope, transaction and the exact cancellation statement',()=>{
    for(const change of [{identity:['reused','123']},{user:'bob'},{database:'other'},{client:'other'},{transaction:'new'},{statement:['next-query']}])expect(sameTarget(target,{...target,...change},'cancel')).toBe(false)
    expect(sameTarget(target,{...target,statement:['next-query']},'terminate')).toBe(true)
  })
  it('retains immutable single-use reviews bound to the source and explicit confirmation',()=>{
    let now=1;const store=new ActivityReviews(()=>now),preview=store.prepare(session,target,'cancel')
    preview.sql='KILL 999';preview.identity[0]='tampered'
    const request={sessionId:'source',reviewId:preview.id,confirmation:preview.confirmation,acknowledge:true as const}
    expect(store.consume(request).preview.sql).toContain('pg_cancel_backend');expect(()=>store.consume(request)).toThrow(/used/)
    const expired=store.prepare(session,target,'terminate');now+=60001;expect(()=>store.consume({...request,reviewId:expired.id})).toThrow(/expired/)
    const wrong=store.prepare(session,target,'cancel');expect(()=>store.consume({...request,sessionId:'other',reviewId:wrong.id})).toThrow(/another/)
    const typo=store.prepare(session,target,'cancel');expect(()=>store.consume({...request,reviewId:typo.id,confirmation:'CANCEL 1'})).toThrow(/exact/)
  })
  it('invalidates reviews on refresh/disconnect and replacement',()=>{
    const store=new ActivityReviews(),a=store.prepare(session,target,'terminate');store.prepare(session,target,'cancel')
    const request={sessionId:'source',reviewId:a.id,confirmation:a.confirmation,acknowledge:true as const};expect(()=>store.consume(request)).toThrow()
    const b=store.prepare(session,target,'terminate');store.forget(session.id);expect(()=>store.consume({...request,reviewId:b.id})).toThrow()
  })
  it.each(['postgres','mysql','mariadb','sqlserver','azure-sql','oracle'] as DatabaseEngine[])('revalidates %s on a point query without fetching SQL text',async engine=>{
    const statements:string[]=[],id=engine==='oracle'?'1:123':'123'
    await readTarget({engine,database:'db',currentSessionId:'456',query:async sql=>{statements.push(sql);return [['alice','db','host','1','abc','tx','123',null]]}},id)
    expect(statements[0]).toMatch(/^SELECT/);expect(statements[0]).not.toMatch(/SQL_TEXT|LEFT\(INFO|SELECT query,/i)
  })
  it('uses native serial/SQL IDs and guarded PostgreSQL/TDS dispatch',()=>{
    expect(actionSql('oracle','cancel',{...target,id:'1:123',identity:['5','date'],statement:['123456789abcd','7:date']})).toBe("ALTER SYSTEM CANCEL SQL '123,5,@1,123456789abcd'")
    expect(actionSql('mariadb','cancel',{...target,statement:['987']})).toBe('KILL SOFT QUERY ID 987')
    expect(actionSql('sqlserver','terminate',target)).toContain('connection_id')
    expect(actionSql('postgres','cancel',target)).toContain('query_start::text')
  })
  it('refuses incomplete Oracle executions and MariaDB thread identities',async()=>{
    const observer:ActivityObserver={engine:'oracle',database:'db',currentSessionId:'1:456',query:async()=>[['alice','db','host','1','123456789abcd',null,'date',':']]}
    const incomplete=await readTarget(observer,'1:123');expect(()=>actionSql('oracle','cancel',incomplete)).toThrow(/active statement/)
    await expect(readTarget({...observer,engine:'mariadb',query:async()=>[['alice','db','host','0',null,null,'123',null]]},'123')).rejects.toThrow(/thread identity/)
  })
  it('reports Oracle marking a session for deferred termination as requested',async()=>{
    let calls=0;const observer:ActivityObserver={engine:'oracle',database:'db',currentSessionId:'1:456',query:async()=>{if(++calls===1)return [['alice','db','host','5',null,'tx','date',null]];throw Object.assign(new Error('session marked for kill'),{errorNum:31})}}
    expect(await dispatchAction(observer,'terminate',{...target,id:'1:123',identity:['5','date'],statement:null},()=>{})).toMatchObject({status:'requested',message:expect.stringContaining('pending')})
  })
  it.each(['sqlserver','azure-sql'] as const)('reports %s KILL permission denial without retrying or claiming an unknown outcome',async engine=>{
    let calls=0
    const observer:ActivityObserver={engine,database:'db',currentSessionId:'456',query:async()=>{
      if(++calls===1)return [['alice','db','host','started',null,'tx','123',null]]
      throw Object.assign(new Error('User does not have permission to use the KILL statement.'),{code:'EREQUEST',number:6102})
    }}
    const result=await dispatchAction(observer,'terminate',{...target,statement:null},()=>{})
    expect(result).toMatchObject({status:'rejected',message:expect.stringContaining('(6102)')})
    expect(calls).toBe(2)
  })
  it('never dispatches after a stale identity, missing target or failed final protection check',async()=>{
    let writes=0
    const observer:ActivityObserver={engine:'postgres',database:'db',currentSessionId:'456',query:async sql=>{if(sql.includes('pg_cancel_backend'))writes++;return [['alice','db','host','started','query-start','tx','123',null]]}}
    await expect(dispatchAction(observer,'cancel',{...target,identity:['old','123']},()=>{})).rejects.toThrow(/changed/)
    await expect(dispatchAction(observer,'cancel',target,()=>{throw new Error('locked')})).rejects.toThrow(/locked/)
    await expect(dispatchAction({...observer,query:async()=>[]},'cancel',target,()=>{})).rejects.toThrow(/disappeared/)
    expect(writes).toBe(0)
  })
  it('distinguishes acceptance, refusal and ambiguous post-dispatch errors without retries',async()=>{
    for(const [outcome,status] of [[[['t']],'requested'],[[],'not-applied'],[Object.assign(new Error('denied'),{code:'42501'}),'rejected'],[Object.assign(new Error('unrecognized engine error'),{code:'6102'}),'unknown'],[new Error('socket closed'),'unknown']] as const){
      let calls=0;const observer:ActivityObserver={engine:'postgres',database:'db',currentSessionId:'456',query:async()=>{if(++calls===1)return [['alice','db','host','started','query-start','tx','123',null]];if(outcome instanceof Error)throw outcome;return outcome.map(row=>[...row])}}
      expect((await dispatchAction(observer,'cancel',target,()=>{})).status).toBe(status);expect(calls).toBe(2)
    }
  })
})
