import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ConnectionConfig } from '../src/shared/contracts'

/** Disposable monitoring principal, provisioned inside the runner's existing container. No image changes. */
export function activityMonitor(config:ConnectionConfig,control=false):{config:ConnectionConfig;enableControl():void;enableRollback():void;cleanup():void} {
  const engine=config.engine==='azure-sql'?'sqlserver':config.engine
  if(['postgres','sqlite','duckdb'].includes(engine))return {config,enableControl(){},enableRollback(){},cleanup(){}}
  const project=process.env.SQLCOMMANDER_TEST_PROJECT
  if(!project||!/^dbcommander-test-\d+$/.test(project)||config.host!=='localhost')throw new Error('Monitoring fixture grants require the disposable Docker runner.')
  const container=execFileSync('docker',['ps','--filter',`label=com.docker.compose.project=${project}`,'--filter',`label=com.docker.compose.service=${engine}`,'--format','{{.ID}}'],{encoding:'utf8'}).trim()
  if(!/^[a-f0-9]{12,64}$/.test(container))throw new Error('Expected exactly one disposable fixture container.')
  const user='inspect_'+randomUUID().replaceAll('-','').slice(0,12),password='Local-Monitor-Only2026'
  const admin=(sql:string)=>{
    const args=engine==='oracle'?['sqlplus','-s','/','as','sysdba']:engine==='sqlserver'?['/opt/mssql-tools18/bin/sqlcmd','-S','localhost','-U','sa','-P','Local-SA-Only!2026','-C','-b','-Q',sql]:[engine==='mysql'?'mysql':'mariadb','-uroot','-plocal-root-test-only','-e',sql]
    execFileSync('docker',['exec','-i',container,...args],{input:engine==='oracle'?`WHENEVER SQLERROR EXIT SQL.SQLCODE\nALTER SESSION SET CONTAINER=FREEPDB1;\n${sql}\nEXIT;\n`:undefined,stdio:['pipe','pipe','pipe'],timeout:30000})
  }
  if(engine==='oracle')admin(`CREATE USER ${user} IDENTIFIED BY "${password}";\nGRANT CREATE SESSION TO ${user};\nGRANT SELECT ON SYS.V_$SESSION TO ${user};\nGRANT SELECT ON SYS.V_$LOCK TO ${user};\nGRANT SELECT ON SYS.V_$SQL TO ${user};`)
  else if(engine==='sqlserver')admin(`USE master; CREATE LOGIN ${user} WITH PASSWORD='${password}',CHECK_POLICY=OFF; GRANT VIEW SERVER STATE TO ${user}; GRANT VIEW SERVER PERFORMANCE STATE TO ${user}; USE dbcommander; CREATE USER ${user} FOR LOGIN ${user};`)
  else admin(`CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'; GRANT SELECT ON dbcommander.* TO '${user}'@'%'; GRANT PROCESS ON *.* TO '${user}'@'%';${engine==='mysql'?` GRANT SELECT ON performance_schema.* TO '${user}'@'%';`:''}`)
  const enableControl=()=>admin(engine==='oracle'?`GRANT ALTER SYSTEM TO ${user};`:engine==='sqlserver'?`USE master; GRANT ALTER ANY CONNECTION TO ${user};`:`GRANT ${engine==='mysql'?'CONNECTION_ADMIN':'CONNECTION ADMIN'} ON *.* TO '${user}'@'%';`)
  const enableRollback=()=>{if(engine==='oracle')admin(`GRANT SELECT ON SYS.V_$TRANSACTION TO ${user};\nGRANT SELECT ON SYS.V_$FAST_START_TRANSACTIONS TO ${user};`)}
  if(control)enableControl()
  return {enableControl,enableRollback,config:{...config,user:engine==='oracle'?user.toUpperCase():user,password},cleanup(){
    if(engine==='oracle')admin(`DROP USER ${user} CASCADE;`)
    else if(engine==='sqlserver')admin(`USE dbcommander; DROP USER ${user}; USE master; DROP LOGIN ${user};`)
    else admin(`DROP USER '${user}'@'%';`)
  }}
}
