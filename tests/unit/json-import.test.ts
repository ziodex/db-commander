import { expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJsonImport } from '../../src/transfer/json'
import { openImport } from '../../src/transfer/import'
import { exportFile } from '../../src/transfer/export'
import { importSourceSchema, transferRequestSchema } from '../../src/shared/transfer'

const document = (rows: unknown[], names = ['id','text','note']) => JSON.stringify({columns:names.map(name=>({name,typeId:0,typeName:'text'})),rows})
async function* chunks(text: string, width = 7) { for(let i=0;i<text.length;i+=width)yield text.slice(i,i+width) }
async function parse(text: string, width = 7) { const rows=[];for await(const row of parseJsonImport(chunks(text,width)))rows.push(row);return rows }

it('imports exact strings, NULLs, empty text and escapes across every token boundary', async () => {
  const rows = [['9223372036854775807','quotes" slash\\ backspace\b tab\t CR\r LF\n Ω 😀',null],['9007199254740993.12345678','', '\\N'],['null','true','{"nested":"as text"}']]
  for(const width of [1,2,3,7,65536]) expect(await parse('\uFEFF'+document(rows),width)).toEqual([['id','text','note'],...rows])
  const escaped = '{"columns":[{"typeName":"VARCHAR","typeId":4294967295,"name":"value"}],"rows":[["\\u03a9\\ud83d\\ude00"]]}'
  expect(await parse(escaped,1)).toEqual([['value'],['Ω😀']])
  expect(await parse('{"columns":[{"name":"value"}],"rows":[]}')).toEqual([['value']])
})
it.each([
  '', '[]', '{}', '{"rows":[],"columns":[{"name":"id"}]}', '{"columns":[],"rows":[]}',
  '{"columns":["id"],"rows":[]}', '{"columns":[{"name":"id","name":"second"}],"rows":[]}',
  '{"columns":[{"name":"id","sql":"DROP TABLE t"}],"rows":[]}', '{"columns":[{"typeId":0}],"rows":[]}',
  '{"columns":[{"name":"id","typeId":1.2}],"rows":[]}', '{"columns":[{"name":"id","typeName":1}],"rows":[]}',
  document([],['id','id']), document([],['']), document([[1]],['id']), document([[9007199254740992]],['id']),
  document([[true]],['id']), document([[{}]],['id']), document([[[]]],['id']), document([['1','2']],['id']), document([[]],['id']),
  '{"columns":[{"name":"id"}],"rows":[["1"],]}', '{"columns":[{"name":"id"}],"rows":[["1",]]}',
  '{"columns":[{"name":"id"},],"rows":[]}', '{"columns":[{"name":"id",}],"rows":[]}',
  document([['\0']],['id']), document([['\ud800']],['id']), document([['\udc00']],['id']),
  '{"columns":[{"name":"id"}],"rows":[["\\x20"]]}', '{"columns":[{"name":"id"}],"rows":[["\n"]]}',
  document([],['id'])+' garbage', document([],['id'])+document([],['id']), document([],['id']).replace(']}','],"extra":0}'),
  document([],['id']).slice(0,-1), document([['unfinished']],['id']).slice(0,-4)
])('rejects malformed, ambiguous or lossy JSON without accepting partial input (%#)', async text => {
  await expect(parse(text,3)).rejects.toThrow()
})
it('does not echo imported data in parser diagnostics', async () => {
  const secret='private-import-value'
  for(const text of [document([[secret,true]],['a','b']),document([[secret]],['a']).slice(0,-3)+'x"]]}']) {
    try { await parse(text); throw new Error('Expected parser rejection') }
    catch(error) { expect((error as Error).message).not.toContain(secret); expect((error as Error).message).not.toContain('Expected parser rejection') }
  }
})
it('bounds strings, header/row size, whitespace and columns before allocation grows unbounded', async () => {
  expect(await parse(document([['x'.repeat(16384)]],['id']),65536)).toHaveLength(2)
  const escaped='{"columns":[{"name":"id"}],"rows":[["'+'\\u0061'.repeat(16384)+'"]]}'
  expect((await parse(escaped,65536))[1][0]).toHaveLength(16384)
  for(const text of [document([['x'.repeat(16385)]],['id']),document([],Array.from({length:101},(_,i)=>'c'+i)),
    document([Array(70).fill('x'.repeat(16384))],Array.from({length:70},(_,i)=>'c'+i)),
    ' '.repeat(1024*1024+1)+document([],['id']),document([],['id'])+' '.repeat(1024*1024+1)]) await expect(parse(text,65536)).rejects.toThrow(/limit|exceeds|100 columns/)
})
it('streams records lazily and closes the input when a bounded preview stops', async () => {
  let reads=0,closed=false
  const text=document(Array.from({length:5000},(_,i)=>[String(i)]),['id'])
  async function* source() { try { for(const chunk of text.match(/.{1,64}/gs)!) { reads++;yield chunk } } finally { closed=true } }
  const records=parseJsonImport(source())
  expect((await records.next()).value).toEqual(['id'])
  for(let i=0;i<10;i++)expect((await records.next()).value).toEqual([String(i)])
  expect(reads).toBeLessThan(10);expect(closed).toBe(false)
  await records.return(undefined);expect(closed).toBe(true)
})
it('opens UTF-8 files, refuses invalid files and detects edits or replacement at the selected path', async () => {
  const directory=await mkdtemp(join(tmpdir(),'dbcommander-json-')), file=join(directory,'input.json'), moved=join(directory,'old.json')
  try {
    await writeFile(file,document([['😀'.repeat(8000)]],['id']))
    let source=await openImport(file,'json')
    expect(source.headers).toEqual(['id']);expect((await source.records.next()).value).toEqual(['😀'.repeat(8000)]);expect(await source.unchanged()).toBe(true)
    await writeFile(file,document([['changed']],['id']));expect(await source.unchanged()).toBe(false);await source.close()
    source=await openImport(file,'json');await rename(file,moved);await writeFile(file,await readFile(moved))
    expect(await source.unchanged()).toBe(false);await source.close()
    source=await openImport(file,'json');await rm(file);expect(await source.unchanged()).toBe(false);await source.close()
    for(const bytes of [Buffer.from([0xff,0xfe,0x61]),Buffer.from([0xef,0xbb,0xbf,0xff])]) { await writeFile(file,bytes);await expect(openImport(file,'json')).rejects.toThrow() }
    await expect(openImport(directory,'json')).rejects.toThrow(/regular/)
    if(process.platform!=='win32') { const link=join(directory,'link.json');await symlink(moved,link);await expect(openImport(link,'json')).rejects.toThrow(/symbolic link/) }
  } finally {await rm(directory,{recursive:true,force:true})}
})
it('round trips the production JSON exporter without converting strings to numbers', async () => {
  const directory=await mkdtemp(join(tmpdir(),'dbcommander-json-export-')), file=join(directory,'data.json')
  const rows=[['9007199254740993.12345678',null],['9223372036854775807','']], columns=[{name:'exact',typeId:1700},{name:'note',typeId:25,typeName:'text'}]
  try {
    await exportFile({action:'export',sessionId:'test',sql:'SELECT 1',format:'json',file,confirmed:true},{signal:new AbortController().signal,progress(){}},async consume=>{
      await consume({type:'result',sessionId:'test',queryId:'test',result:{index:0,statement:'SELECT 1',columns,rowCount:null,command:'SELECT',truncated:false}})
      await consume({type:'rows',sessionId:'test',queryId:'test',index:0,rows})
    })
    const source=await openImport(file,'json'), actual=[]
    try { for await(const row of source.records)actual.push(row);expect(actual).toEqual(rows);expect(await source.unchanged()).toBe(true) } finally {await source.close()}
  } finally {await rm(directory,{recursive:true,force:true})}
})
it('accepts JSON import through strict IPC schemas without renderer-supplied SQL or source types', () => {
  const source={sessionId:'e21c06a3-a25c-475a-bac4-39ab8747cb0d',table:{schema:'public',name:'items'},file:'/tmp/values.json',format:'json'}
  expect(importSourceSchema.parse(source)).toEqual(source)
  const request={...source,action:'import',mapping:['id'],signature:'a'.repeat(64),confirmed:true}
  expect(transferRequestSchema.parse(request)).toEqual(request)
  for(const extra of [{sql:'DELETE FROM items'},{columns:[{name:'id',type:'INTEGER'}]},{confirmed:false},{format:'jsonl'},{parameters:[]}])expect(transferRequestSchema.safeParse({...request,...extra}).success).toBe(false)
})
