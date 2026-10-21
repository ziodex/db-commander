import { describe,expect,it } from 'vitest'
import { diagramExportSchema,diagramRequestSchema,diagramSvg,diagramLayout,diagramBounds,edgePath,nodeHeight,tableKey,type DiagramNode,type DiagramEdge } from '../../src/shared/diagram'
import { readDiagram } from '../../src/catalog/diagram'
import type { CatalogObject } from '../../src/shared/catalog'
const object:CatalogObject={schema:'public',name:'parent',kind:'table',identity:'1'},node:DiagramNode={id:tableKey(object),object,columns:[{name:'id',type:'integer',nullable:false,primaryKey:true}],notices:[]}
const child:DiagramNode={...node,id:tableKey({...object,name:'child'}),object:{...object,name:'child',identity:'2'}},edge:DiagramEdge={id:'key',source:child.id,target:node.id,name:'child_fk',columns:['parent_id'],targetColumns:['id'],targetTable:object,targetVisible:true}
const adapter={async list(){return {objects:[object],truncated:false,notice:'test catalog'}},async detail(){throw new Error('Definitions must not be read for diagrams')}}
describe('ER diagram boundaries',()=>{
  it('rejects arbitrary SQL, views, empty/oversized scopes and unbounded export coordinates',()=>{
    const valid={sessionId:'00000000-0000-4000-8000-000000000001',tables:[object]}
    expect(diagramRequestSchema.parse(valid)).toEqual(valid)
    for(const value of [{...valid,sql:'DROP TABLE x'},{...valid,tables:[]},{...valid,tables:Array(41).fill(object)},{...valid,tables:[{...object,kind:'view'}]}])expect(()=>diagramRequestSchema.parse(value)).toThrow()
    expect(()=>diagramExportSchema.parse({title:'t',nodes:[],edges:[],positions:{x:{x:Infinity,y:0}},showColumns:true,caption:''})).toThrow()
  })
  it('keeps qualified identities distinct and lays out cyclic graphs without overlapping nodes',()=>{
    expect(tableKey(object)).not.toBe(tableKey({...object,catalog:'attached'}));expect(tableKey(object)).not.toBe(tableKey({...object,schema:'other'}))
    const nodes=[node,child,{...node,id:'third',columns:Array(100).fill(node.columns[0])}],edges=[edge,{...edge,id:'reverse',source:node.id,target:child.id},{...edge,id:'self',source:'third',target:'third'}]
    const p=diagramLayout(nodes,edges,true);expect(diagramLayout(nodes,edges,true)).toEqual(p)
    for(const a of nodes)for(const b of nodes)if(a.id!==b.id)expect(Math.abs(p[a.id].x-p[b.id].x)>=300||p[a.id].y+nodeHeight(a,true)<=p[b.id].y||p[b.id].y+nodeHeight(b,true)<=p[a.id].y).toBe(true)
    expect(edgePath(edges[2],p)).toContain('C');expect(diagramBounds(nodes,p,true).height).toBeGreaterThan(2300)
  })
  it('exports inert SVG even when database identifiers contain active markup',()=>{
    const bad={...node,object:{...object,name:'<script>alert("x")</script>&'},columns:[{...node.columns[0],name:'<image href="https://bad"/>',type:'" onload="bad'}]}
    const svg=diagramSvg({title:'<svg onload="bad">',nodes:[bad],edges:[],positions:{[node.id]:{x:50,y:50}},showColumns:true,caption:'A & B\uD800'})
    expect(svg).toContain('&lt;script&gt;');expect(svg).not.toContain('<script');expect(svg).not.toContain('<image');expect(svg).not.toContain('foreignObject');expect(svg).toContain('A &amp; B�')
  })
  it('resolves visible identities before requesting columns and rejects stale/repeated selections',async()=>{
    let calls=0
    const query=async()=>{calls++;return []}
    await expect(readDiagram(adapter,query,'postgres',{tables:[{...object,identity:'stale'}]},'catalog-connection')).rejects.toThrow(/no longer visible/)
    await expect(readDiagram(adapter,query,'postgres',{tables:[object,object]},'catalog-connection')).rejects.toThrow(/only once/)
    expect(calls).toBe(0)
  })
  it('bounds wide tables and reports relationship failures without claiming a complete graph',async()=>{
    const result=await readDiagram(adapter,async sql=>{if(sql.includes('pg_constraint'))throw new Error('permission denied');return Array.from({length:101},(_,i)=>[String(i),'text','true','false'])},'postgres',{},'catalog-connection')
    expect(result.nodes[0].columns).toHaveLength(100);expect(result.edges).toHaveLength(0);expect(result.notices.join(' ')).toContain('incomplete');expect(result.nodes[0].notices.join(' ')).toContain('permission denied')
  })
  it('rejects a graph when a table is replaced during metadata collection',async()=>{
    let reads=0
    const changing={...adapter,async list(){return {objects:[{...object,identity:++reads===1?'1':'2'}],truncated:false,notice:''}}}
    await expect(readDiagram(changing,async sql=>sql.includes('pg_constraint')?[]:[['id','integer','false','true']],'postgres',{},'catalog-connection')).rejects.toThrow(/changed while/)
  })
  it('resolves SQLite reference spelling to the visible qualified table identity',async()=>{
    const sqliteObjects=[{...object,schema:'main'},{...child.object,schema:'main'}],catalog={...adapter,async list(){return {objects:sqliteObjects,truncated:false,notice:''}}}
    const result=await readDiagram(catalog,async(sql,values)=>sql.includes('pragma_foreign_key_list')?(values?.[1]==='child'?[['0','Foreign key 0','ID','main','PARENT','id']]:[]):[['id','INTEGER','0','1']],'sqlite',{},'session')
    expect(result.edges[0].target).toBe(tableKey(sqliteObjects[0]));expect(result.edges[0].columns).toEqual(['id'])
  })

})
