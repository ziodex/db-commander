import { z } from 'zod'
import { catalogObjectSchema, type CatalogObject } from './catalog'
import { idSchema, type GridTable } from './contracts'

export const DIAGRAM_TABLE_LIMIT = 40
export const DIAGRAM_COLUMN_LIMIT = 100
export const DIAGRAM_EDGE_LIMIT = 200
const diagramScopeSchema = z.object({ tables: z.array(catalogObjectSchema.refine(o => o.kind === 'table', 'Select base tables.')).min(1).max(DIAGRAM_TABLE_LIMIT).optional() }).strict()
export const diagramRequestSchema = diagramScopeSchema.extend({ sessionId: idSchema })
export type DiagramScope = z.infer<typeof diagramScopeSchema>
export type DiagramRequest = z.infer<typeof diagramRequestSchema>
const columnSchema = z.object({ name: z.string().max(255), type: z.string().max(512), nullable: z.boolean(), primaryKey: z.boolean() }).strict()
const nodeSchema = z.object({ id: z.string().max(2048), object: catalogObjectSchema, columns: z.array(columnSchema).max(DIAGRAM_COLUMN_LIMIT), notices: z.array(z.string().max(1000)).max(10) }).strict()
const targetSchema = z.object({ catalog: z.string().max(255).optional(), schema: z.string().max(255), name: z.string().max(255) }).strict()
const edgeSchema = z.object({ id: z.string().max(4096), source: z.string().max(2048), target: z.string().max(2048).optional(), name: z.string().max(255), columns: z.array(z.string().max(255)).max(200), targetColumns: z.array(z.string().max(255)).max(200), targetTable: targetSchema, targetVisible: z.boolean() }).strict()
export type DiagramNode = z.infer<typeof nodeSchema>
export type DiagramEdge = z.infer<typeof edgeSchema>
export interface DiagramSnapshot { nodes: DiagramNode[]; edges: DiagramEdge[]; available: CatalogObject[]; notices: string[]; fetchedAt: string; source: 'catalog-connection' | 'session' }
export interface Point { x: number; y: number }
export const diagramExportSchema = z.object({ title: z.string().max(8192), nodes: z.array(nodeSchema).max(DIAGRAM_TABLE_LIMIT), edges: z.array(edgeSchema).max(DIAGRAM_EDGE_LIMIT), positions: z.record(z.string().max(2048), z.object({ x: z.number().min(0).max(50000), y: z.number().min(0).max(50000) }).strict()).refine(p => Object.keys(p).length <= DIAGRAM_TABLE_LIMIT), showColumns: z.boolean(), caption: z.string().max(8000) }).strict().refine(value => value.nodes.reduce((count,node)=>count+node.columns.length,0)<=2000 && JSON.stringify(value).length<=3_000_000, 'Diagram export exceeds its metadata budget.')
export type DiagramExport = z.infer<typeof diagramExportSchema>
export function tableKey(table: GridTable) { return JSON.stringify([table.catalog ?? '', table.schema, table.name]) }
export function tableLabel(table: GridTable) { return [table.catalog,table.schema,table.name].filter(Boolean).join('.') }
export const NODE_WIDTH = 300, ROW_HEIGHT = 23
export function nodeHeight(node: DiagramNode, showColumns: boolean) { return 64 + (showColumns ? node.columns.length * ROW_HEIGHT : 0) + (node.notices.length ? 24 : 0) }
/** Deterministic bounded grid, with connected components placed together. */
export function diagramLayout(nodes: DiagramNode[], edges: DiagramEdge[], showColumns: boolean): Record<string,Point> {
  const remaining = new Set(nodes.map(n => n.id)), order: string[] = []
  while (remaining.size) {
    const queue = [remaining.values().next().value!]; remaining.delete(queue[0])
    for (let i=0; i<queue.length; i++) {
      const id=queue[i]; order.push(id)
      for (const e of edges) { const neighbor=e.source===id?e.target:e.target===id?e.source:undefined; if(neighbor&&remaining.delete(neighbor))queue.push(neighbor) }
    }
  }
  const positions: Record<string,Point> = {}, width = Math.max(1,Math.ceil(Math.sqrt(nodes.length))), byId = new Map(nodes.map(n=>[n.id,n]))
  let y=50
  for(let i=0;i<order.length;i+=width){const row=order.slice(i,i+width);row.forEach((id,index)=>{positions[id]={x:50+index*390,y}});y+=Math.max(...row.map(id=>nodeHeight(byId.get(id)!,showColumns)))+100}
  return positions
}
export function diagramBounds(nodes: DiagramNode[], positions: Record<string,Point>, showColumns: boolean) { return { width: Math.max(640,...nodes.map(n=>(positions[n.id]?.x??0)+NODE_WIDTH+100)), height: Math.max(300,...nodes.map(n=>(positions[n.id]?.y??0)+nodeHeight(n,showColumns)+70)) } }
export function edgePath(edge: DiagramEdge, positions: Record<string,Point>, lane=0) {
  const from=positions[edge.source],to=edge.target?positions[edge.target]:undefined
  if(!from||!to)return ''
  const offset=(lane%6)*9
  if(edge.source===edge.target)return `M ${from.x+NODE_WIDTH} ${from.y+22} C ${from.x+NODE_WIDTH+65+offset} ${from.y-30} ${from.x+NODE_WIDTH+65+offset} ${from.y+95} ${from.x+NODE_WIDTH} ${from.y+47}`
  const right=to.x>=from.x,x1=from.x+(right?NODE_WIDTH:0),x2=to.x+(right?0:NODE_WIDTH),y1=from.y+26+offset,y2=to.y+26+offset,bend=Math.max(55,Math.abs(x2-x1)/2)
  return `M ${x1} ${y1} C ${x1+(right?bend:-bend)} ${y1} ${x2+(right?-bend:bend)} ${y2} ${x2} ${y2}`
}
export function edgeLabel(edge: DiagramEdge) { return `${edge.name}: (${edge.columns.join(', ')}) → ${tableLabel(edge.targetTable)} (${edge.targetColumns.join(', ')})` }
const xml = (value: string) => value.replace(/[\uD800-\uDFFF]/gu,'�').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'�').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!))
const short = (value:string,length:number) => value.length>length?value.slice(0,length-1)+'…':value
/** Inert SVG only: identifiers are text, with no HTML, links or external assets. */
export function diagramSvg(input: DiagramExport) {
  const data=diagramExportSchema.parse(input),{nodes,edges,positions,showColumns}=data,{width,height}=diagramBounds(nodes,positions,showColumns)
  const text=(x:number,y:number,value:string,extra='')=>`<text x="${x}" y="${y}" ${extra}>${xml(value)}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height+100}" viewBox="0 0 ${width} ${height+100}" role="img"><title>${xml(data.title)}</title><desc>${xml(data.caption)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#537b70"/></marker></defs><rect width="100%" height="100%" fill="#ffffff"/><g font-family="Arial, sans-serif" font-size="12" fill="#172c33">${text(24,25,short(data.title,Math.floor(width/10)),'font-size="18"')}${edges.map((e,i)=>{const d=edgePath(e,positions,i);return d?`<path d="${d}" fill="none" stroke="#537b70" stroke-width="2" marker-end="url(#arrow)"><title>${xml(edgeLabel(e))}</title></path>`:''}).join('')}${nodes.map(n=>{const p=positions[n.id]??{x:50,y:50};return `<g transform="translate(${p.x} ${p.y})"><title>${xml(tableLabel(n.object))}</title><rect width="${NODE_WIDTH}" height="${nodeHeight(n,showColumns)}" rx="8" fill="#f4f8f7" stroke="#537b70"/>${text(12,22,short(n.object.name,36),'font-weight="bold"')}${text(12,43,short([n.object.catalog,n.object.schema].filter(Boolean).join('.'),42))}${showColumns?n.columns.map((c,i)=>text(12,77+i*ROW_HEIGHT,short(`${c.primaryKey?'PK ':''}${edges.some(e=>e.source===n.id&&e.columns.includes(c.name))?'FK ':''}${c.name} · ${c.type}${c.nullable?' ?':''}`,43))).join(''):''}${n.notices.length?text(12,nodeHeight(n,showColumns)-8,'Incomplete metadata — see description'):''}</g>`}).join('')}${text(24,height+20,'Arrow: declared foreign key → referenced table. No inferred cardinality.')}${text(24,height+42,short(data.caption,Math.floor(width/7)))}</g></svg>`
}
