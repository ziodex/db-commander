import { z } from 'zod'
import type { DatabaseEngine } from './database-engines'
import { lexSql, type Token } from './sql/lexer'

export const scalarParameterTypes = ['text','integer','decimal','date','timestamp','timestamptz','boolean','null','hex'] as const
export const arrayParameterTypes = ['text[]','integer[]','decimal[]','date[]','timestamp[]','timestamptz[]','boolean[]','hex[]'] as const
const parameterTypes = [...scalarParameterTypes, ...arrayParameterTypes] as const
/** Precision/scale are derived from validated decimal text, never from a JS number. */
function decimalShape(value: string) {
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.')
  const scale = fraction.length
  return { precision: Math.max(1, (whole === '0' ? 0 : whole.length) + scale), scale }
}
function monthDays(year: number, month: number) {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}
function validDate(value: string) {
  if (value.length !== 10 || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  return month >= 1 && month <= 12 && day >= 1 && day <= monthDays(year, month)
}
/** Timestamp is a timezone-free calendar value. Avoid Date, UTC conversion and millisecond rounding. */
export function timestampValue(value: string) { const [whole, fraction = ''] = value.replace('T', ' ').split('.'); return whole + '.' + fraction.padEnd(6, '0') }
const timezoneError = 'Timestamp with timezone requires YYYY-MM-DD HH:mm:ss[.ffffff] followed by Z or ±HH:MM (up to ±14:00, excluding -00:00). Both local and UTC dates must be within years 1000–9999.'
/** Fixed offsets identify an instant. Normalize calendar minutes only; never pass fractions through Date or Number. */
export function timestampTzValue(value: string): string {
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value)
  if (!match || value !== value.trim() || !validDate(value.slice(0,10))) throw new Error(timezoneError)
  const zone = match[8], offsetHours = zone === 'Z' ? 0 : Number(zone.slice(1,3)), offsetMinutes = zone === 'Z' ? 0 : Number(zone.slice(4))
  if (offsetHours === 14 && offsetMinutes !== 0 || zone === '-00:00') throw new Error(timezoneError)
  let year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  let minutes = Number(match[4]) * 60 + Number(match[5]) - (zone[0] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes)
  if (minutes < 0) { minutes += 1440; if (--day === 0) { if (--month === 0) { month = 12; year-- } day = monthDays(year,month) } }
  if (minutes >= 1440) { minutes -= 1440; if (++day > monthDays(year,month)) { day = 1; if (++month === 13) { month = 1; year++ } } }
  if (year < 1000 || year > 9999) throw new Error(timezoneError)
  const pad = (n: number) => String(n).padStart(2,'0')
  return `${year}-${pad(month)}-${pad(day)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${match[6]}.${(match[7] ?? '').padEnd(6,'0')}+00:00`
}
const scalarParameterSchema = z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.enum(scalarParameterTypes), value: z.string().max(65536) }).strict().superRefine((p,ctx)=>{
  const invalid = (message:string)=>ctx.addIssue({code:'custom',message})
  if(p.type==='integer'&&(p.value!==p.value.trim()||!/^-?(0|[1-9]\d*)$/.test(p.value)||BigInt(p.value)<-9223372036854775808n||BigInt(p.value)>9223372036854775807n))invalid('Integer parameters must fit a signed 64-bit integer.')
  if(p.type==='boolean'&&!['true','false'].includes(p.value))invalid('Boolean parameters must be true or false.')
  if(p.type==='hex'&&(p.value!==p.value.trim()||!/^[\da-f]*$/i.test(p.value)||p.value.length%2))invalid('Binary parameters require pairs of hexadecimal digits.')
  if(p.type==='null'&&p.value!=='')invalid('NULL parameters cannot contain a value.')
  if(p.type==='decimal'&&(p.value!==p.value.trim()||!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(p.value)||decimalShape(p.value).precision>38||decimalShape(p.value).scale>30))invalid('Decimal parameters require plain decimal notation, at most 38 digits of precision and 30 fractional digits (no exponent or separators).')
  if(p.type==='date'&&!validDate(p.value))invalid('Date parameters require a valid YYYY-MM-DD date from 1000-01-01 through 9999-12-31.')
  if(p.type==='timestamp'&&(p.value!==p.value.trim()||!/^[1-9]\d{3}-\d{2}-\d{2}[ T]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?$/.test(p.value)||!validDate(p.value.slice(0,10))))invalid('Timestamp parameters require YYYY-MM-DD HH:mm:ss with up to six fractional digits, years 1000–9999 and no timezone offset.')
  if(p.type==='timestamptz') { try { timestampTzValue(p.value) } catch { invalid(timezoneError) } }
})
type ScalarQueryParameter = z.infer<typeof scalarParameterSchema>
const parameterSchema = z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.enum(parameterTypes), value: z.string().max(65536) }).strict().superRefine((p,ctx)=>{
  // Zod may continue refinements after a length issue; do not parse oversized JSON.
  if (p.value.length > 65536) return
  if (isArrayParameter(p)) {
    try { arrayParameterInfo(p) } catch (error) { ctx.addIssue({code:'custom',message:(error as Error).message}) }
  } else {
    const parsed = scalarParameterSchema.safeParse(p)
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({code:'custom',message:issue.message})
  }
})
export function isArrayParameter(p: {type: string}) { return p.type.endsWith('[]') }
/** JSON numbers are refused rather than rounded by JSON.parse before validation. */
export function arrayParameterInfo(p: {name: string; type: typeof parameterTypes[number]; value: string}) {
  if (!isArrayParameter(p)) throw new Error('Choose an array parameter type.')
  const elementType = p.type.slice(0,-2) as Exclude<ScalarQueryParameter['type'],'null'>
  let input: unknown
  try { input = JSON.parse(p.value) } catch { throw new Error('Array values must be a JSON array of strings (booleans for boolean[]), with optional null elements.') }
  if (!Array.isArray(input) || input.length > 1000) throw new Error('Array values must be a one-dimensional JSON array with at most 1,000 elements.')
  const values: ScalarQueryParameter[] = input.map((value: unknown,index: number) => {
    if (value !== null && typeof value !== (elementType === 'boolean' ? 'boolean' : 'string')) throw new Error(`Array element ${index + 1} must be ${elementType === 'boolean' ? 'a JSON boolean' : 'a JSON string'} or null. Quote numeric values to preserve precision.`)
    const parsed = scalarParameterSchema.safeParse({ name:p.name, type:value === null ? 'null' : elementType, value:value === null ? '' : String(value) })
    if (!parsed.success) throw new Error(`Array element ${index + 1}: ${parsed.error.issues.map(issue=>issue.message).join(' ')}`)
    return parsed.data
  })
  let whole = 0, scale = 0
  if (elementType === 'decimal') for (const value of values) if (value.type !== 'null') {
    const shape = decimalShape(value.value); whole = Math.max(whole,shape.precision-shape.scale); scale = Math.max(scale,shape.scale)
  }
  const shape = { precision:Math.max(1,whole+scale), scale }
  if (shape.precision > 38) throw new Error('Decimal array elements must fit a common type with at most 38 digits of precision and 30 fractional digits.')
  return { elementType, values, shape }
}
export const parametersSchema=z.array(parameterSchema).min(1).max(100).superRefine((values,ctx)=>{
  if(new Set(values.map(p=>p.name)).size!==values.length)ctx.addIssue({code:'custom',message:'Parameter names must be unique.'})
  if(values.reduce((n,p)=>n+p.value.length,0)>262144)ctx.addIssue({code:'custom',message:'Parameter values exceed 262,144 characters.'})
})
export type QueryParameter=z.infer<typeof parameterSchema>
export function parameterTokens(sql:string,engine:DatabaseEngine,noBackslash=false,ansiQuotes=false) {
  const tokens=lexSql(sql,engine,noBackslash,ansiQuotes), refs:{name:string;start:number;end:number}[]=[]
  for(let i=0;i<tokens.length-1;i++) {
    const t=tokens[i],next=tokens[i+1]
    if(t.text!==':'||t.kind!=='symbol'||t.end!==next.start||next.kind!=='word'||! /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(next.text))continue
    if(engine==='oracle'&&/^(new|old|parent)$/i.test(next.text)&&tokens[i+2]?.text==='.')continue
    refs.push({name:next.text,start:t.start,end:next.end});i++
  }
  return {tokens,refs}
}
export function parameterNames(sql:string,engine:DatabaseEngine,noBackslash=false,ansiQuotes=false) {return [...new Set(parameterTokens(sql,engine,noBackslash,ansiQuotes).refs.map(p=>p.name))]}

/** T-SQL can separate statements without semicolons. Keep parameterized RPCs
 * to a conservative single DML statement, including CTEs, subqueries and unions.
 * This is not a read-only authorization rule; SELECT/functions can have effects. */
function checkTsqlStatement(tokens:Token[], refs:{start:number;end:number}[]) {
  const markers=new Set(refs.flatMap(ref=>[ref.start,ref.start+1]))
  let depth=0,command='',selects=0,sets=0,previous=''
  for(const token of tokens) {
    if(markers.has(token.start))continue
    if(token.text==='('){depth++;continue}
    if(token.text===')'){depth--;if(depth<0)throw new Error('Unbalanced query parentheses.');if(!depth)previous=')';continue}
    if(token.kind!=='word')continue
    const word=token.text.toUpperCase()
    if(/^(GO|DELIMITER|EXEC|EXECUTE|DECLARE|USE|CREATE|ALTER|DROP|TRUNCATE|MERGE|BACKUP|RESTORE|DBCC|WAITFOR|COMMIT|ROLLBACK|GRANT|REVOKE|DENY|BEGIN|PRINT|RAISERROR|THROW|RETURN|GOTO|IF|WHILE|BREAK|CONTINUE|CHECKPOINT|KILL|SHUTDOWN|RECONFIGURE|OPEN|CLOSE|FETCH|DEALLOCATE|SAVE|ENABLE|DISABLE|BULK|RECEIVE|SEND)$/.test(word))throw new Error('Bound T-SQL accepts one DML statement without control commands.')
    if(depth)continue
    if(['SELECT','INSERT','UPDATE','DELETE'].includes(word)) {
      if(!command)command=word
      else if(word!=='SELECT'||!['SELECT','INSERT'].includes(command))throw new Error('Bound T-SQL accepts one statement at a time.')
      if(word==='SELECT'&&selects++>0&&!['UNION','ALL','DISTINCT','EXCEPT','INTERSECT'].includes(previous))throw new Error('Bound T-SQL accepts one SELECT, including set operations, at a time.')
    }
    if(word==='SET'&&(command!=='UPDATE'||sets++>0))throw new Error('Run SET commands separately from bound queries.')
    previous=word
  }
  if(depth||!command)throw new Error('Unbalanced or unsupported parameterized T-SQL statement.')
}

function scalarExpression(p: ScalarQueryParameter, engine: DatabaseEngine, marker: string, commonDecimal?: ReturnType<typeof decimalShape>) {
  const mysql = ['mysql','mariadb'].includes(engine), tds = ['sqlserver','azure-sql'].includes(engine)
  let expression=marker
  if(p.type==='integer')expression=`CAST(${marker} AS ${mysql?'SIGNED':engine==='oracle'?'NUMBER(19)': 'BIGINT'})`
  if(p.type==='boolean')expression=`CAST(${marker} AS ${engine==='postgres'||engine==='duckdb'?'BOOLEAN':tds?'BIT':mysql?'UNSIGNED':engine==='oracle'?'NUMBER(1)':'INTEGER'})`
  if(p.type==='decimal') {
    const { precision, scale } = commonDecimal ?? decimalShape(p.value)
    const type = `${engine==='oracle'?'NUMBER':'DECIMAL'}(${precision},${scale})`
    // Oracle's string-to-number conversion otherwise depends on session NLS settings.
    const number = engine==='oracle' ? `TO_NUMBER(${marker}, '${'9'.repeat(Math.max(1,precision-scale))}${scale?'D'+'9'.repeat(scale):''}', 'NLS_NUMERIC_CHARACTERS=''.,''')` : marker
    expression = `CAST(${number} AS ${engine==='sqlite'?'TEXT':type})`
  }
  if(p.type==='date')expression=engine==='oracle'?`TO_DATE(${marker}, 'FXYYYY-MM-DD', 'NLS_CALENDAR=GREGORIAN')`:tds?`CONVERT(DATE, ${marker}, 23)`:`CAST(${marker} AS ${engine==='sqlite'?'TEXT':'DATE'})`
  if(p.type==='timestamp')expression=engine==='oracle'?`TO_TIMESTAMP(${marker}, 'FXYYYY-MM-DD HH24:MI:SS.FF6', 'NLS_CALENDAR=GREGORIAN')`:tds?`CONVERT(DATETIME2(6), ${marker}, 121)`:`CAST(${marker} AS ${engine==='sqlite'?'TEXT':mysql?'DATETIME(6)':engine==='postgres'?'TIMESTAMP(6) WITHOUT TIME ZONE':'TIMESTAMP'})`
  // Transport has normalized the instant to UTC. Oracle attaches UTC explicitly;
  // MySQL/MariaDB expose UTC calendar fields because DATETIME has no timezone.
  if(p.type==='timestamptz')expression=engine==='oracle'?`FROM_TZ(TO_TIMESTAMP(REPLACE(SUBSTR(${marker}, 1, 26), 'T', ' '), 'FXYYYY-MM-DD HH24:MI:SS.FF6', 'NLS_CALENDAR=GREGORIAN'), '+00:00')`:tds?`CONVERT(DATETIMEOFFSET(6), ${marker}, 127)`:mysql?`CAST(REPLACE(SUBSTRING(${marker}, 1, 26), 'T', ' ') AS DATETIME(6))`:`CAST(${marker} AS ${engine==='sqlite'?'TEXT':engine==='postgres'?'TIMESTAMP(6) WITH TIME ZONE':'TIMESTAMPTZ'})`
  // Give text parameters a stable type; NULL keeps server context inference.
  if(engine==='postgres'&&p.type==='text')expression=`CAST(${marker} AS TEXT)`
  // A standalone binary bind otherwise defaults to text in PostgreSQL/MySQL,
  // which rejects NUL/invalid UTF-8 or decodes bytes as replacement characters.
  if(p.type==='hex'&&(engine==='postgres'||mysql))expression=`CAST(${marker} AS ${mysql?'BINARY':'BYTEA'})`
  return expression
}
function arrayElementSqlType(engine: DatabaseEngine, type: Exclude<ScalarQueryParameter['type'],'null'>, shape: ReturnType<typeof decimalShape>) {
  const mysql = ['mysql','mariadb'].includes(engine), tds = ['sqlserver','azure-sql'].includes(engine)
  if (type === 'text') return engine === 'oracle' ? 'VARCHAR2(4000)' : tds ? 'NVARCHAR(MAX)' : mysql ? 'CHAR' : 'TEXT'
  if (type === 'integer') return engine === 'oracle' ? 'NUMBER(19)' : mysql ? 'SIGNED' : 'BIGINT'
  if (type === 'decimal') return engine === 'sqlite' ? 'TEXT' : `${engine === 'oracle' ? 'NUMBER' : 'DECIMAL'}(${shape.precision},${shape.scale})`
  if (type === 'boolean') return engine === 'oracle' ? 'NUMBER(1)' : tds ? 'BIT' : mysql ? 'UNSIGNED' : engine === 'sqlite' ? 'INTEGER' : 'BOOLEAN'
  if (type === 'hex') return engine === 'postgres' ? 'BYTEA' : engine === 'oracle' ? 'RAW(2000)' : tds ? 'VARBINARY(MAX)' : mysql ? 'BINARY' : 'BLOB'
  if (engine === 'sqlite') return 'TEXT'
  if (type === 'date') return 'DATE'
  if (mysql) return 'DATETIME(6)'
  if (tds) return type === 'timestamptz' ? 'DATETIMEOFFSET(6)' : 'DATETIME2(6)'
  if (type === 'timestamptz') return engine === 'duckdb' ? 'TIMESTAMPTZ' : 'TIMESTAMP(6) WITH TIME ZONE'
  return engine === 'postgres' ? 'TIMESTAMP(6) WITHOUT TIME ZONE' : engine === 'oracle' ? 'TIMESTAMP(6)' : 'TIMESTAMP'
}

/** Only marker spans are rewritten; values never become SQL source. */
export function compileParameters(sql:string,engine:DatabaseEngine,input:QueryParameter[],noBackslash=false,ansiQuotes=false) {
  const parameters=parametersSchema.parse(input),{tokens,refs}=parameterTokens(sql,engine,noBackslash,ansiQuotes)
  if(tokens.some(t=>!t.closed&&!(t.kind==='comment'&&!t.text.startsWith('/*'))))throw new Error('Unterminated SQL token in parameterized query.')
  const code=tokens.filter(t=>t.kind!=='comment'),end=code.at(-1)?.text===';'?code.slice(0,-1):code
  if(!/^(SELECT|WITH|INSERT|UPDATE|DELETE)$/i.test(end[0]?.text??'')||end.some(t=>t.text===';'))throw new Error('Bound parameters support one SELECT, WITH, INSERT, UPDATE or DELETE statement. Run scripts and session commands separately.')
  if(tokens.some(t=>t.kind==='comment'&&/^\/\*(?:!|M!)/i.test(t.text)))throw new Error('Executable comments are not supported with bound parameters.')
  if(end.some(t=>t.kind==='symbol'&&(t.text==='?'&&engine!=='postgres'||t.text==='$')||t.kind==='word'&&/^@(?!@)/.test(t.text)))throw new Error('Use :name parameters; native placeholder styles cannot be mixed.')
  const byName=new Map(parameters.map(p=>[p.name,p])),names=new Set(refs.map(p=>p.name))
  if(!refs.length||names.size!==byName.size||[...names].some(name=>!byName.has(name)))throw new Error('Supply exactly the named parameters used by the selected statement.')
  if(refs.length>1000)throw new Error('A statement may use up to 1,000 parameter occurrences.')
  const values:ScalarQueryParameter[]=[], mysql=['mysql','mariadb'].includes(engine), tds=['sqlserver','azure-sql'].includes(engine)
  if(tds)checkTsqlStatement(end,refs)
  const arrays = new Map(parameters.filter(isArrayParameter).map(p=>[p.name,arrayParameterInfo(p)]))
  const indexes = new Map(code.map((token,index)=>[token.start,index])), parents = new Map<number,number|undefined>(), stack:number[]=[]
  code.forEach((token,index)=>{parents.set(index,stack.at(-1));if(token.text==='(')stack.push(index);else if(token.text===')')stack.pop()})
  function bind(p: ScalarQueryParameter, shape?: ReturnType<typeof decimalShape>) {
    if (values.length >= 1000) throw new Error('A statement may bind at most 1,000 scalar values after array expansion, including repeated parameters.')
    const i=values.push(p),marker=mysql||engine==='sqlite'?'?':tds?`@sc_p${i}`:engine==='oracle'?`:sc_p${i}`:`$${i}`
    return scalarExpression(p,engine,marker,shape)
  }
  let output='',at=0
  for(const ref of refs) {
    const p=byName.get(ref.name)!, array=arrays.get(p.name)
    let expression:string
    if (array) {
      const index=indexes.get(ref.start)!, parent=parents.get(index)
      const inList=parent!==undefined && code[parent-1]?.kind==='word' && code[parent-1].text.toUpperCase()==='IN'
      if (inList && (index!==parent!+1 || code[index+2]?.text!==')')) throw new Error('An array must be the only value inside IN (:name) or NOT IN (:name).')
      if (!inList && engine!=='postgres' && engine!=='duckdb') throw new Error(`Array parameters on ${engine} require IN (:name) or NOT IN (:name). Native array expressions are supported on PostgreSQL and DuckDB.`)
      const type=arrayElementSqlType(engine,array.elementType,array.shape)
      const items=array.values.map(value=>bind(value,array.elementType==='decimal'?array.shape:undefined)).join(', ')
      expression=inList ? (items || `SELECT CAST(NULL AS ${type})${engine==='oracle'?' FROM dual':''} WHERE 1 = 0`) : `CAST(${engine==='postgres'?'ARRAY':''}[${items}] AS ${type}[])`
    } else expression=bind(p as ScalarQueryParameter)
    output+=sql.slice(at,ref.start)+expression;at=ref.end
  }
  const trailing=code.at(-1)?.text===';'?code.at(-1)!.start:-1
  output+=trailing>=at?sql.slice(at,trailing)+sql.slice(trailing+1):sql.slice(at)
  return {sql:output,values}
}
