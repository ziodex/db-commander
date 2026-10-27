import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WorkspaceStore } from '../../src/storage/store'
import { DEFAULT_HISTORY_SETTINGS } from '../../src/shared/query-library'
import type { HistoryEntry } from '../../src/shared/contracts'
let directory:string,store:WorkspaceStore
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'dbcommander-library-'));store=new WorkspaceStore(join(directory,'workspace.sqlite'))})
afterEach(()=>{store.close();rmSync(directory,{recursive:true,force:true})})
function add(index:number,patch:Partial<HistoryEntry>={}) {const entry:HistoryEntry={id:randomUUID(),sql:`SELECT ${index}`,connection:'Local',database:'work',engine:'postgres',status:'completed',startedAt:new Date(Date.now()+index).toISOString(),durationMs:index,...patch};store.addHistory(entry);return entry}
it('searches literal SQL and exact execution context with stable pagination',()=>{
  const first=add(1,{sql:"SELECT '100%_ Ω'",status:'failed'});add(2,{connection:'Other'});add(3,{database:'other'});add(4,{engine:'sqlite'})
  expect(store.searchHistory({text:'100%_'}).entries[0].id).toBe(first.id)
  expect(store.searchHistory({text:"%' OR 1=1--"}).total).toBe(0)
  expect(store.searchHistory({text:'select',connection:'Local',database:'work',engine:'postgres',status:'failed'}).total).toBe(1)
  expect(store.searchHistory({from:first.startedAt,to:first.startedAt}).entries.map(e=>e.id)).toEqual([first.id])
  const all=store.searchHistory().entries.map(e=>e.id)
  expect(store.searchHistory({limit:2}).entries.map(e=>e.id).concat(store.searchHistory({offset:2,limit:2}).entries.map(e=>e.id))).toEqual(all)
})
it('enforces age and count retention while honoring the favorite exemption',()=>{
  const favorite=add(0,{startedAt:'2020-01-01T00:00:00.000Z'});store.favoriteHistory(favorite.id,true)
  add(1,{startedAt:'2020-01-02T00:00:00.000Z'});for(let i=2;i<6;i++)add(i)
  store.saveHistorySettings({...DEFAULT_HISTORY_SETTINGS,maxEntries:2,maxAgeDays:7})
  expect(store.searchHistory().total).toBe(3);expect(store.searchHistory({favorites:true}).entries[0].id).toBe(favorite.id)
  store.saveHistorySettings({...DEFAULT_HISTORY_SETTINGS,maxEntries:2,maxAgeDays:7,keepFavorites:false})
  expect(store.searchHistory().total).toBe(2);expect(store.searchHistory({favorites:true}).total).toBe(0)
})
it('disables recording without deleting history and persists retention controls',()=>{
  add(1);store.saveHistorySettings({...DEFAULT_HISTORY_SETTINGS,enabled:false,maxEntries:45,maxAgeDays:30});add(2)
  store.close();store=new WorkspaceStore(join(directory,'workspace.sqlite'))
  expect(store.historySettings()).toEqual({...DEFAULT_HISTORY_SETTINGS,enabled:false,maxEntries:45,maxAgeDays:30});expect(store.history()).toHaveLength(1)
  expect(()=>store.saveHistorySettings({...DEFAULT_HISTORY_SETTINGS,maxEntries:0})).toThrow();expect(store.history()).toHaveLength(1)
})
it('never stores bound values and updates status without losing favorites',()=>{
  const entry=add(1,{sql:'SELECT :secret',parameters:[{name:'secret',type:'text',value:'never-store-this-secret'} as never]})
  store.favoriteHistory(entry.id,true);store.addHistory({...entry,status:'cancelled',durationMs:10})
  expect(store.history()[0]).toMatchObject({favorite:true,status:'cancelled',parameters:[{name:'secret',type:'text'}]})
  const db=new DatabaseSync(join(directory,'workspace.sqlite'));expect(JSON.stringify(db.prepare('SELECT * FROM history').all())).not.toContain('never-store-this-secret');db.close()
})
it('clears selected history without losing snippets and supports snippet CRUD across restart',()=>{
  const first=add(1);store.favoriteHistory(first.id,true);const second=add(2)
  const saved=store.saveSnippet({name:'Lookup',description:'Find customer',sql:'SELECT :name',engine:'mysql',favorite:true})
  store.deleteHistory(second.id);expect(store.searchHistory().total).toBe(1);add(3);store.clearHistory(false);expect(store.searchHistory().total).toBe(1)
  store.close();store=new WorkspaceStore(join(directory,'workspace.sqlite'))
  expect(store.snippets({text:'CUSTOMER',favorites:true,engine:'mysql'})).toEqual([saved])
  const {createdAt,updatedAt,...input}=saved;const changed=store.saveSnippet({...input,name:'Updated'});expect(changed.createdAt).toBe(createdAt);expect(store.snippets()).toHaveLength(1)
  store.clearHistory(true);expect(store.history()).toEqual([]);expect(store.snippets()).toHaveLength(1)
  store.deleteSnippet(saved.id);expect(store.snippets()).toEqual([]);expect(()=>store.saveSnippet(input)).toThrow(/no longer exists/)
  expect(()=>store.saveSnippet({...input,id:undefined,password:'secret'} as never)).toThrow()
})
it('migrates a v2 database with a readable backup and preserves existing execution records',()=>{
  store.close();const path=join(directory,'workspace.sqlite');rmSync(path)
  const old=new DatabaseSync(path);old.exec("CREATE TABLE workspace(id INTEGER PRIMARY KEY,value TEXT);CREATE TABLE history(id TEXT PRIMARY KEY,connection TEXT,sql TEXT,status TEXT,startedAt TEXT,durationMs INTEGER);INSERT INTO history VALUES('old','Local','SELECT 42','completed','2026-01-01',5);PRAGMA user_version=2");old.close()
  store=new WorkspaceStore(path);expect(store.history()[0]).toMatchObject({id:'old',favorite:false,parameters:[]})
  const backups=readdirSync(directory).filter(p=>p.includes('v2-backup'));expect(backups).toHaveLength(1)
  const backup=new DatabaseSync(join(directory,backups[0]));expect(backup.prepare('PRAGMA user_version').get()!.user_version).toBe(2);expect(backup.prepare('SELECT sql FROM history').get()!.sql).toBe('SELECT 42');backup.close()
  store.close();store=new WorkspaceStore(path);expect(store.history()[0].id).toBe('old');expect(readdirSync(directory).filter(p=>p.includes('v2-backup'))).toHaveLength(1)
})
