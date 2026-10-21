import { objectKey } from '../shared/catalog'
import { DIAGRAM_COLUMN_LIMIT, DIAGRAM_EDGE_LIMIT, DIAGRAM_TABLE_LIMIT, tableKey, type DiagramScope, type DiagramSnapshot } from '../shared/diagram'
import type { DatabaseEngine } from '../shared/contracts'
import { GridSql } from '../driver/grid-sql'
import { foreignKeys } from '../driver/foreign-keys'
import type { CatalogAdapter, CatalogQuery } from './common'

export async function readDiagram(adapter: CatalogAdapter, query: CatalogQuery, engine: DatabaseEngine, scope: DiagramScope, source: DiagramSnapshot['source']): Promise<DiagramSnapshot> {
  const catalog=await adapter.list(),available=catalog.objects.filter(o=>o.kind==='table'),notices=[engine==='oracle'?'Tables owned by the current Oracle user.':['sqlite','duckdb'].includes(engine)?'Includes this tab’s attached and temporary catalogs.':['mysql','mariadb'].includes(engine)?'Tables in the current database. Referenced tables in other databases may be outside this catalog.':'Visible user tables in the current database.'],d=new GridSql(engine)
  if(catalog.truncated)notices.push('Catalog limit reached: some tables and relationships may be unavailable.')
  const selected=scope.tables?scope.tables.map(o=>{const current=available.find(c=>objectKey(c)===objectKey(o));if(!current)throw new Error('A selected table is no longer visible. Reopen the diagram to refresh its table list.');return current}):available.slice(0,DIAGRAM_TABLE_LIMIT)
  if(new Set(selected.map(objectKey)).size!==selected.length)throw new Error('Select each table only once.')
  if(!scope.tables&&available.length>DIAGRAM_TABLE_LIMIT)notices.push(`Showing the first ${DIAGRAM_TABLE_LIMIT} tables. Choose a smaller scope to explore other relationships.`)
  const result:DiagramSnapshot={nodes:[],edges:[],available,notices,fetchedAt:new Date().toISOString(),source},deadline=Date.now()+45000
  const fold=(name:string)=>['sqlite','duckdb'].includes(engine)?name.replace(/[A-Z]/g,c=>c.toLowerCase()):name
  const sameTable=(a:import('../shared/contracts').GridTable,b:import('../shared/contracts').GridTable)=>fold(a.catalog??'')===fold(b.catalog??'')&&fold(a.schema)===fold(b.schema)&&fold(a.name)===fold(b.name)
  let remainingColumns=2000
  const bounded:CatalogQuery=async(sql,values)=>{if(Date.now()>deadline)throw new Error('Diagram metadata timed out. Select fewer tables and retry.');return query(sql,values)}
  for(const object of selected){
    const node:DiagramSnapshot['nodes'][number]={id:tableKey(object),object,columns:[],notices:[]};result.nodes.push(node)
    try {
      let {sql,values}=d.metadata(object,true)
      if(engine==='oracle')sql=sql.replace(" AND k.STATUS='ENABLED'",'')
      if(d.mssql)sql=sql.replace(/^SELECT /,'SELECT TOP (101) ');else sql+=engine==='oracle'?' FETCH FIRST 101 ROWS ONLY':' LIMIT 101'
      const rows=await bounded(sql,values)
      if(!rows.length)throw new Error('Columns unavailable; the table may have changed or require metadata privileges.')
      const limit=Math.min(DIAGRAM_COLUMN_LIMIT,remainingColumns)
      node.columns=rows.slice(0,limit).map(row=>({name:row[0]!,type:(row[1]??'').slice(0,512),nullable:['1','true','t'].includes(row[2]??''),primaryKey:['1','true','t'].includes(row[3]??'')}))
      remainingColumns-=node.columns.length
      if(rows.length>limit||rows.some(r=>(r[1]?.length??0)>512))node.notices.push('Column display limit reached; metadata is incomplete.')
    }catch(error){node.notices.push(`Columns: ${(error as Error).message}`.slice(0,1000))}
    try {
      const refs=await foreignKeys(d,object,async(sql,values)=>({rows:await bounded(sql,values),affected:0}))
      for(const ref of refs){
        if(result.edges.length>=DIAGRAM_EDGE_LIMIT){node.notices.push('Relationship display limit reached; metadata is incomplete.');break}
        const canonical=available.find(o=>sameTable(o,ref.target)),targetTable=canonical?{catalog:canonical.catalog,schema:canonical.schema,name:canonical.name}:ref.target,key=tableKey(targetTable)
        result.edges.push({id:node.id+ref.id,source:node.id,target:selected.some(o=>tableKey(o)===key)?key:undefined,name:ref.name,columns:ref.columns,targetColumns:ref.targetColumns,targetTable,targetVisible:Boolean(canonical)})
      }
    }catch(error){node.notices.push(`Relationships: ${(error as Error).message}`.slice(0,1000))}
    if(Date.now()>deadline)throw new Error('Diagram metadata timed out. Select fewer tables and retry.')
  }
  for(const edge of result.edges){
    const sourceNode=result.nodes.find(n=>n.id===edge.source),targetNode=result.nodes.find(n=>n.id===edge.target)
    edge.columns=edge.columns.map(name=>sourceNode?.columns.find(c=>fold(c.name)===fold(name))?.name??name)
    edge.targetColumns=edge.targetColumns.map(name=>targetNode?.columns.find(c=>fold(c.name)===fold(name))?.name??name)
  }
  if(result.nodes.some(n=>n.notices.length))notices.push('Some table metadata is incomplete. Select a table to read its notices; missing lines do not prove there are no foreign keys.')
  if(result.edges.some(e=>!e.target))notices.push('Some referenced tables are outside this diagram or are not visible. Select a relationship for its ordered column mapping.')
  // Catalog identity is checked again so dropped/replaced tables cannot masquerade as the selection.
  const current=await adapter.list()
  if(selected.some(o=>!current.objects.some(c=>objectKey(c)===objectKey(o))))throw new Error('The selected tables changed while reading metadata. Reopen the diagram and retry.')
  result.fetchedAt=new Date().toISOString()
  return result
}
