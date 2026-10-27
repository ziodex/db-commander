import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fixtureFingerprint, prepareFixtureImages } from '../../scripts/fixture-images.mjs'
function fixture(){const root=mkdtempSync(join(tmpdir(),'fixture-reuse-'));const write=(name,text='test')=>{mkdirSync(dirname(join(root,name)),{recursive:true});writeFileSync(join(root,name),text)};for(const name of ['compose.yaml','.dockerignore','tests/docker/Dockerfile.postgres','tests/docker/Dockerfile.sqlite','scripts/build-sqlite-worker.mjs','scripts/build-windows-owner-guard.mjs','scripts/build-windows-sqlserver.mjs','src/main.ts','tests/test.ts','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc','patches/dependency.patch','vitest.config.ts','tsconfig.json'])write(name);return {root,write,cleanup:()=>rmSync(root,{recursive:true,force:true})}}
it('reuses matching fixture images without a build or registry call',()=>{const f=fixture();try{const hash=fixtureFingerprint('postgres',f.root,'aarch64'),calls=[];prepareFixtureImages({engines:['postgres'],root:f.root,overrideFile:join(f.root,'override.json'),log:()=>{},run:(_cmd,args)=>{calls.push(args);return {status:0,stdout:args[0]==='info'?'aarch64':args[3].includes('.Id')?'sha256:'+ 'a'.repeat(64)+' '+hash:hash}},compose:()=>{throw new Error('A matching image must not rebuild')}});expect(calls.map(c=>c[0])).toEqual(['info','image','image'])}finally{f.cleanup()}})
it('rebuilds missing or changed images and pulls only on explicit refresh',()=>{const f=fixture();try{for(const refresh of [false,true]){const commands=[];prepareFixtureImages({engines:['postgres'],root:f.root,overrideFile:join(f.root,'override.json'),refresh,log:()=>{},run:(_cmd,args)=>args[0]==='info'?{status:0,stdout:'aarch64'}:args[3].includes('.Id')?{status:0,stdout:'sha256:'+'a'.repeat(64)+' '+fixtureFingerprint('postgres',f.root,'aarch64')}:{status:1,stdout:''},compose:args=>{commands.push(args);return {status:0}}});expect(commands).toEqual([['build',...(refresh?['--pull']:[]),'postgres']])}}finally{f.cleanup()}})
it('tracks embedded sources, filenames, dependency inputs and architecture but not unrelated network source changes',()=>{const f=fixture();try{const pg=fixtureFingerprint('postgres',f.root,'aarch64'),sqlite=fixtureFingerprint('sqlite',f.root,'aarch64');f.write('src/main.ts','changed');expect(fixtureFingerprint('postgres',f.root,'aarch64')).toBe(pg);expect(fixtureFingerprint('sqlite',f.root,'aarch64')).not.toBe(sqlite);expect(fixtureFingerprint('postgres',f.root,'x86_64')).not.toBe(pg);f.write('tests/docker/Dockerfile.postgres','new base');expect(fixtureFingerprint('postgres',f.root,'aarch64')).not.toBe(pg)}finally{f.cleanup()}})

it('refuses a tag replaced by a concurrent build before pinning the run',()=>{const f=fixture();try{const hash=fixtureFingerprint('postgres',f.root,'aarch64');expect(()=>prepareFixtureImages({engines:['postgres'],root:f.root,overrideFile:join(f.root,'override.json'),log:()=>{},run:(_cmd,args)=>({status:0,stdout:args[0]==='info'?'aarch64':args[3].includes('.Id')?'sha256:'+'a'.repeat(64)+' wrong-hash':hash}),compose:()=>{throw new Error('Unexpected build')}})).toThrow(/changed during preparation/)}finally{f.cleanup()}})

it.each(['build-windows-owner-guard.mjs', 'build-windows-sqlserver.mjs'])('invalidates SQLite fixtures when imported helper %s changes', helper => {
  const f = fixture()
  try {
    const before = fixtureFingerprint('sqlite', f.root, 'aarch64')
    f.write(`scripts/${helper}`, 'changed imported helper')
    expect(fixtureFingerprint('sqlite', f.root, 'aarch64')).not.toBe(before)
  } finally { f.cleanup() }
})

it('invalidates embedded fixtures when an installed dependency patch changes', () => {
  const f = fixture()
  try {
    const before = fixtureFingerprint('sqlite', f.root, 'aarch64')
    f.write('patches/dependency.patch', 'updated dependency fix')
    expect(fixtureFingerprint('sqlite', f.root, 'aarch64')).not.toBe(before)
  } finally { f.cleanup() }
})
