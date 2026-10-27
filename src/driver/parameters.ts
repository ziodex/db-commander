import type { DriverRunRequest } from './driver'
import type { DatabaseEngine } from '../shared/contracts'
import { compileParameters, parameterTokens, timestampValue, timestampTzValue, isArrayParameter, type QueryParameter } from '../shared/parameters'

export function bindRequest(request:DriverRunRequest,engine:DatabaseEngine,noBackslash=false,ansiQuotes=false):DriverRunRequest {
  if(!request.parameters&&parameterTokens(request.sql,engine,noBackslash,ansiQuotes).refs.length)throw new Error('Bind parameters are required. Supply values for every :name before executing SQL.')
  return request.parameters?{...request,bound:compileParameters(request.sql,engine,request.parameters,noBackslash,ansiQuotes)}:request
}
export function boundValue(p:QueryParameter):string|Buffer|null {
  if (isArrayParameter(p)) throw new Error('Array parameters must be compiled into scalar bindings before transport.')
  return p.type==='null'?null:p.type==='hex'?Buffer.from(p.value,'hex'):p.type==='boolean'?(p.value==='true'?'1':'0'):p.type==='timestamp'?timestampValue(p.value):p.type==='timestamptz'?timestampTzValue(p.value):p.value
}
