import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'

const dockerfiles = {postgres:'postgres',mysql:'mysql-family',mariadb:'mysql-family',sqlserver:'sqlserver',oracle:'oracle',ssh:'ssh',sqlite:'sqlite',duckdb:'duckdb'}
const copied = {
  postgres:[],mysql:[],mariadb:[],
  sqlserver:['tests/docker/mssql.conf','tests/docker/sqlserver-init.sql'],
  oracle:['tests/docker/oracle-listener.ora','tests/docker/oracle-sqlnet.ora','tests/docker/oracle-init.sql','tests/docker/oracle-ready.sh'],
  ssh:['tests/docker/sshd_config','tests/docker/ssh-entrypoint.sh']
}
// Hash everything COPY places in an image, including file names and permissions.
// Mounted SQL fixtures do not need an image rebuild. compose.yaml includes build args/platform.
export function fixtureFingerprint(engine, root, architecture) {
  if (!dockerfiles[engine]) throw new Error(`Unknown Docker fixture: ${engine}`)
  const hash=createHash('sha256').update(JSON.stringify(['dbcommander-fixtures-v1',engine,architecture]))
  const embedded=['sqlite','duckdb'].includes(engine)
  const paths=['compose.yaml','.dockerignore',`tests/docker/Dockerfile.${dockerfiles[engine]}`,...(embedded?['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc','src','tests','vitest.config.ts','tsconfig.json',...(engine==='sqlite'?['scripts/build-sqlite-worker.mjs','scripts/build-windows-owner-guard.mjs']:[])]:copied[engine])]
  function add(path){const absolute=resolve(root,path),stat=statSync(absolute);if(stat.isDirectory()){for(const name of readdirSync(absolute).sort())add(relative(root,resolve(absolute,name)))}else{hash.update(JSON.stringify([path.replaceAll('\\','/'),stat.mode&0o777,stat.size]));hash.update(readFileSync(absolute))}}
  for(const path of paths)add(path)
  return hash.digest('hex')
}
export function prepareFixtureImages({ engines, root, overrideFile, run, compose, refresh=false, log=console.log }) {
  const info=run('docker',['info','--format','{{.Architecture}}'],{encoding:'utf8',stdio:'pipe'})
  if(info.status!==0)throw new Error('Docker is unavailable; start Docker before running driver tests.')
  const architecture=String(info.stdout).trim().replace(/[^a-zA-Z0-9_-]/g,'')
  if(!architecture)throw new Error('Docker did not report its architecture.')
  const plans=engines.map(engine=>({engine,image:`dbcommander-fixture-${engine}:${architecture}`,hash:fixtureFingerprint(engine,root,architecture)}))
  const writeOverride=()=>writeFileSync(overrideFile,JSON.stringify({services:Object.fromEntries(plans.map(p=>[p.engine,{image:p.pinnedImage??p.image,build:{labels:{'org.dbcommander.fixture-input':p.hash}}}]))},null,2))
  writeOverride()
  const missing=[]
  for(const plan of plans){
    const inspect=run('docker',['image','inspect','--format','{{ index .Config.Labels "org.dbcommander.fixture-input" }}',plan.image],{encoding:'utf8',stdio:'pipe'})
    if(!refresh&&inspect.status===0&&String(inspect.stdout).trim()===plan.hash)log(`Reusing Docker fixture: ${plan.engine} (${plan.image})`)
    else{missing.push(plan.engine);log(`Building Docker fixture: ${plan.engine} (${refresh?'explicit refresh':'missing image or changed inputs'})`)}
  }
  if(missing.length&&compose(['build',...(refresh?['--pull']:[]),...missing]).status!==0)throw new Error('Could not build Docker fixture images.')
  // Pin this run to immutable image IDs. Another checkout can rebuild the stable
  // tags without changing the images used by our isolated containers.
  for(const plan of plans){
    const inspected=run('docker',['image','inspect','--format','{{.Id}} {{ index .Config.Labels "org.dbcommander.fixture-input" }}',plan.image],{encoding:'utf8',stdio:'pipe'})
    const [image,hash]=String(inspected.stdout??'').trim().split(/\s+/)
    if(inspected.status!==0||hash!==plan.hash||!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error(`Docker fixture ${plan.engine} changed during preparation. Retry after the other build finishes.`)
    plan.pinnedImage=image
  }
  writeOverride()
}
