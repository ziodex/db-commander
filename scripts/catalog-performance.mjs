import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cpus, totalmem, release } from 'node:os'
import { fileURLToPath } from 'node:url'
const supported=['postgres','mysql','mariadb','sqlserver','oracle']
const desktop=process.argv.includes('--desktop'),args=process.argv.slice(2).filter(arg=>!['--','--desktop'].includes(arg)), index=args.indexOf('--driver')
const embedded=args.length===1&&args[0]==='--embedded'
if(!embedded&&args.length && (index!==0 || args.length!==2))throw new Error('Use --embedded, or --driver postgres,mysql,mariadb,sqlserver,oracle to select performance fixtures.')
const selected=embedded?[]:index===-1?supported:[...new Set(args[1].split(','))]
if(!embedded&&(!selected.length||selected.some(engine=>!supported.includes(engine))))throw new Error('Unknown server performance fixture.')
if(!embedded&&desktop&&(selected.length!==1||selected[0]!=='mariadb'))throw new Error('The server desktop performance fixture currently requires --driver mariadb --desktop.')
const evidence=resolve(process.env.SQLCOMMANDER_CATALOG_EVIDENCE??`.test-artifacts/catalog-performance-${process.pid}`)
mkdirSync(evidence,{recursive:true,mode:0o700})
const docker=spawnSync('docker',['info','--format','{{json .}}'],{encoding:'utf8'}), info=docker.status===0?JSON.parse(docker.stdout):undefined
writeFileSync(resolve(evidence,'host.json'),JSON.stringify({platform:process.platform,arch:process.arch,release:release(),node:process.versions.node,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),docker:info?{architecture:info.Architecture,cpus:info.NCPU,memoryBytes:info.MemTotal,version:info.ServerVersion}:undefined},null,2))
console.log(`Catalog performance evidence: ${evidence}`)
if(embedded) {
  const env={...process.env,SQLCOMMANDER_TEST_DRIVERS:'sqlite,duckdb',SQLCOMMANDER_CATALOG_PERFORMANCE:'1',SQLCOMMANDER_CATALOG_EVIDENCE:evidence,PLAYWRIGHT_JUNIT_OUTPUT_FILE:resolve(evidence,'desktop.xml')}
  delete env.ELECTRON_RUN_AS_NODE
  for(const args of [
    [resolve('node_modules/vitest/vitest.mjs'),'run','tests/integration/catalog-performance.test.ts','--reporter=default','--reporter=junit',`--outputFile.junit=${resolve(evidence,'integration.xml')}`],
    [fileURLToPath(import.meta.resolve('@playwright/test/cli')),'test','tests/desktop/catalog-performance.spec.ts',`--output=${resolve(evidence,'desktop')}`]
  ]) {
    const result=spawnSync(process.execPath,args,{stdio:'inherit',env})
    if(result.error)console.error(result.error)
    if(result.status!==0){process.exitCode=result.status??1;break}
  }
}
// One database at a time keeps measurements isolated and bounds Docker memory.
for(const engine of selected) {
  const directory=resolve(evidence,engine); mkdirSync(directory,{recursive:true,mode:0o700})
  const result=spawnSync(process.execPath,[resolve('scripts/test-drivers.mjs'),'--driver',engine,'--integration-filter','catalog performance',...(desktop?['--desktop','--desktop-filter','catalog performance mariadb:']:[])],{stdio:'inherit',env:{...process.env,SQLCOMMANDER_CATALOG_PERFORMANCE:'1',SQLCOMMANDER_CATALOG_EVIDENCE:directory,SQLCOMMANDER_TEST_REPORT_DIR:directory,PLAYWRIGHT_JUNIT_OUTPUT_FILE:resolve(directory,'desktop.xml')}})
  if(result.error)console.error(result.error)
  if(result.status!==0){process.exitCode=result.status??1;break}
}
