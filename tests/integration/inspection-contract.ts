import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { DriverRegistry } from '../../src/driver/registry'
import { quoteIdentifier } from '../../src/shared/sql/common'
import type { ConnectionConfig, DatabaseEvent, GridSnapshot, GridTable } from '../../src/shared/contracts'
import { INSPECT_LIMIT } from '../../src/shared/inspection'

export async function verifyInspection(config:ConnectionConfig) {
  const directory=mkdtempSync(join(tmpdir(),'dbcommander-inspect-')),events:DatabaseEvent[]=[],engine=config.engine
  const embedded=['sqlite','duckdb'].includes(engine), oracle=engine==='oracle',server=['sqlserver','azure-sql'].includes(engine)
  const local={...config,...(embedded?{filePath:join(directory,'inspect.db'),sqliteMode:'create' as const,duckdbMode:'create' as const}:{})}
  const driver=new DriverRegistry(event=>{events.push(event)},{workerPath:resolve('out/main/sqlite-worker.cjs')})
  let session=await driver.connect(local)
  const q=(s:string)=>quoteIdentifier(s,engine),literal=(s:string)=>(server?"N'":"'")+s.replaceAll("'","''")+"'",prefix='inspect_'+randomUUID().slice(0,8),parent=prefix+" p'",child=prefix+" c'",key="O'Brien ; -- Ω"
  const keyType=server?'NVARCHAR(120)':'VARCHAR(120)'
  const textType=oracle?'CLOB':server?'NVARCHAR(MAX)':['mysql','mariadb'].includes(engine)?'LONGTEXT':'TEXT'
  const xmlType=oracle?'XMLTYPE':['postgres','sqlserver','azure-sql'].includes(engine)?'XML':'TEXT'
  const binaryType=engine==='postgres'?'BYTEA':oracle?'BLOB':server?'VARBINARY(MAX)':['mysql','mariadb'].includes(engine)?'MEDIUMBLOB':'BLOB'
  const bytes='00ff8041'.repeat(40000),binary=engine==='postgres'?`decode('${bytes}','hex')`:oracle?`TO_BLOB(HEXTORAW('00ff8041'))`:engine==='duckdb'?`from_hex('${bytes}')`:server?`0x${bytes}`:`X'${bytes}'`
  const long=oracle?`RPAD(TO_CLOB('x'),300000,'x')`:engine==='sqlite'?`replace(hex(zeroblob(150000)),'0','x')`:server?`REPLICATE(CAST('x' AS varchar(max)),300000)`:`repeat('x',300000)`
  const xml='<root><value>Ω &amp; safe</value></root>',json='{"n":9007199254740993,"a":1,"a":2}'
  const xmlValue=oracle?`XMLTYPE(${literal(xml)})`:['postgres','sqlserver','azure-sql'].includes(engine)?`CAST(${literal(xml)} AS XML)`:literal(xml)
  let table:GridTable,grid:GridSnapshot
  async function run(sql:string,id=session.id) {const queryId=driver.start({sessionId:id,sql,maxRows:100});await driver.wait(id);const completion=events.find(e=>e.type==='complete'&&e.queryId===queryId) as Extract<DatabaseEvent,{type:'complete'}>;expect(completion?.status,completion?.error).toBe('completed');return queryId}
  async function browse(id=session.id) {const response=await driver.editGrid({action:'browse',sessionId:id,table});expect(response.error).toBeUndefined();return response.grid!}
  async function inspect(column:string,row=0,id=session.id,snapshot=grid) {const response=await driver.editGrid({action:'inspect-cell',sessionId:id,snapshotId:snapshot.id,row,column:snapshot.columns.findIndex(c=>c.name===column)});expect(response.error).toBeUndefined();expect(response.session.transaction).toBe('idle');return response.inspection!}
  try {
    await run(`CREATE TABLE ${q(parent)} (${q('tenant')} INTEGER,${q('code')} ${keyType},${q('label')} VARCHAR(80),PRIMARY KEY(${q('tenant')},${q('code')}))`)
    await run(`CREATE TABLE ${q(child)} (${q('id')} INTEGER PRIMARY KEY,${q('tenant')} INTEGER,${q('code')} ${keyType},${q('document')} ${textType},${q('markup')} ${xmlType},${q('payload')} ${binaryType},${q('large')} ${textType},CONSTRAINT ${q(prefix+'_fk')} FOREIGN KEY(${q('tenant')},${q('code')}) REFERENCES ${q(parent)}(${q('tenant')},${q('code')}))`)
    await run(`INSERT INTO ${q(parent)} VALUES(7,${literal(key)},'right'); INSERT INTO ${q(parent)} VALUES(8,${literal(key)},'wrong')`)
    await run(`INSERT INTO ${q(child)} VALUES(1,7,${literal(key)},${literal(json)},${xmlValue},${binary},${long})`)
    if(oracle)await run(`DECLARE b BLOB; chunk RAW(20000) := UTL_RAW.COPIES(HEXTORAW('00ff8041'),5000); BEGIN SELECT ${q('payload')} INTO b FROM ${q(child)} WHERE ${q('id')}=1 FOR UPDATE; DBMS_LOB.TRIM(b,0); FOR i IN 1..8 LOOP DBMS_LOB.WRITEAPPEND(b,UTL_RAW.LENGTH(chunk),chunk); END LOOP; END;`)
    await run(`INSERT INTO ${q(child)} VALUES(2,NULL,NULL,NULL,NULL,NULL,NULL)`)
    if(oracle)await run('COMMIT')
    const found=(await driver.schema(session.id)).objects.find(o=>o.name===child)!
    table={schema:found.schema,name:child,...(found.catalog?{catalog:found.catalog}:{})}
    const cached=await run(oracle?'SELECT 42 FROM dual':'SELECT 42')
    grid=await browse()
    expect(grid.cellMarks?.some(m=>m.column===6&&m.row===0&&m.truncated)).toBe(!oracle) // CLOB is a page placeholder.
    const before=events.length
    expect((await inspect('document')).value).toBe(json)
    expect((await inspect('markup')).value).toContain('safe')
    const large=await inspect('large');expect(large.value).toBe('x'.repeat(INSPECT_LIMIT));expect(large.truncated).toBe(true)
    const bin=await inspect('payload');expect(bin.encoding).toBe('hex');expect(bin.value?.toLowerCase()).toBe(bytes.slice(0,INSPECT_LIMIT));expect(bin.truncated).toBe(true)
    expect((await inspect('payload',1)).value).toBeNull()
    expect((await inspect('document',1)).value).toBeNull()
    expect(events.length).toBe(before)
    const file=join(directory,'cached.csv');await driver.exportCsv(cached,0,file);expect(readFileSync(file,'utf8')).toContain('42')
    const other=await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write'})
    await run(`UPDATE ${q(child)} SET ${q('document')}='changed outside' WHERE ${q('id')}=1`,other.id);if(oracle)await run('COMMIT',other.id)
    expect((await inspect('document')).value).toBe('changed outside')
    await run(`UPDATE ${q(child)} SET ${q('document')}=${literal(json)} WHERE ${q('id')}=1`,other.id);if(oracle)await run('COMMIT',other.id)
    await run(`DELETE FROM ${q(child)} WHERE ${q('id')}=2`,other.id);if(oracle)await run('COMMIT',other.id)
    expect((await driver.editGrid({action:'inspect-cell',sessionId:session.id,snapshotId:grid.id,row:1,column:3})).error).toMatch(/deleted/)
    await run(`INSERT INTO ${q(child)} VALUES(2,NULL,NULL,NULL,NULL,NULL,NULL)`,other.id);if(oracle)await run('COMMIT',other.id)
    await driver.disconnect(other.id)
    const refs=await driver.editGrid({action:'foreign-keys',sessionId:session.id,snapshotId:grid.id});expect(refs.error).toBeUndefined();expect(refs.references).toHaveLength(1)
    const ref=refs.references![0];expect(ref.columns).toEqual(['tenant','code']);expect(ref.targetColumns).toEqual(['tenant','code'])
    expect((await driver.editGrid({action:'follow-reference',sessionId:session.id,snapshotId:grid.id,row:1,referenceId:ref.id})).error).toMatch(/NULL/)
    expect((await driver.editGrid({action:'follow-reference',sessionId:session.id,snapshotId:grid.id,row:0,referenceId:'f'.repeat(64)})).error).toMatch(/changed/)
    const target=await driver.editGrid({action:'follow-reference',sessionId:session.id,snapshotId:grid.id,row:0,referenceId:ref.id})
    expect(target.error).toBeUndefined();expect(target.grid?.rows).toEqual([['7',key,'right']]);expect(target.grid?.query.filters).toHaveLength(2)
    expect((await driver.editGrid({action:'inspect-cell',sessionId:session.id,snapshotId:grid.id,row:0,column:0})).error).toMatch(/expired/)
    grid=await browse()
    expect((await driver.editGrid({action:'apply',sessionId:session.id,snapshotId:grid.id,changes:[{kind:'delete',row:0}]})).error).toMatch(/expired/)
    // Protected reads work; inspection and traversal grant no write authority.
    const locked=await driver.connect({...local,environment:'production',sqliteMode:'read-write',duckdbMode:'read-write'})
    const protectedGrid=await browse(locked.id);expect((await inspect('document',0,locked.id,protectedGrid)).value).toBe(json);await driver.disconnect(locked.id)
    if(embedded) {
      await driver.disconnect(session.id)
      const ro=await driver.connect({...local,sqliteMode:'read-only',duckdbMode:'read-only'})
      const roGrid=await browse(ro.id);expect((await inspect('document',0,ro.id,roGrid)).value).toBe(json);await driver.disconnect(ro.id)
      session=await driver.connect({...local,sqliteMode:'read-write',duckdbMode:'read-write'});grid=await browse()
    }
    await run(`DELETE FROM ${q(child)} WHERE ${q('id')}=1`);if(oracle)await run('COMMIT')
    expect((await driver.editGrid({action:'inspect-cell',sessionId:session.id,snapshotId:grid.id,row:0,column:0})).error).toMatch(/expired/)
    await run(`DROP TABLE ${q(child)}`);await run(`DROP TABLE ${q(parent)}`)
  } finally {try{await run('ROLLBACK');await run(`DROP TABLE ${q(child)}`);await run(`DROP TABLE ${q(parent)}`)}catch{}await driver.close();rmSync(directory,{recursive:true,force:true})}
}
