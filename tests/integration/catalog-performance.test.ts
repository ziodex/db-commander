import { test } from 'vitest'
import { verifyCatalogPerformance } from './catalog-performance-contract'
for(const engine of ['sqlite','duckdb'] as const) test.skipIf(process.env.SQLCOMMANDER_CATALOG_PERFORMANCE!=='1')(`catalog performance ${engine}: 10000 and 20000 constrained tables`,()=>verifyCatalogPerformance({engine,name:'Private catalog performance',host:'local',port:1,database:'',user:'local',password:'',tls:'disable',sqliteMode:'memory',duckdbMode:'memory'}),600000)
