import { parameterTokens } from './parameters'
import type { DatabaseEngine, SessionInfo } from './contracts'

export function validateExportSql(sql: string, engine: DatabaseEngine, mode?: SessionInfo['mysqlSqlMode']) {
  const scanned = parameterTokens(sql, engine, mode?.noBackslashEscapes, mode?.ansiQuotes)
  if (scanned.tokens.some(token => !token.closed && (token.kind !== 'comment' || token.text.startsWith('/*')))) throw new Error('Complete SQL strings, identifiers and comments before exporting.')
  // Parameter names are data placeholders, even when named :update or :into.
  const markers = new Set(scanned.refs.flatMap(ref => [ref.start, ref.start + 1]))
  const tokens = scanned.tokens.filter(token => token.kind !== 'comment' && !markers.has(token.start))
  if (!['SELECT', 'WITH'].includes(tokens[0]?.text.toUpperCase())) throw new Error('Full-result export requires one SELECT or WITH query.')
  if (tokens.some((token, index) => token.kind === 'symbol' && token.text === ';' && index !== tokens.length - 1) || tokens.some(token => token.kind === 'word' && /^(INSERT|UPDATE|DELETE|MERGE|INTO|CREATE|ALTER|DROP|TRUNCATE|EXEC|EXECUTE|CALL|COPY|ATTACH|DETACH|PRAGMA|COMMIT|ROLLBACK|GRANT|REVOKE|GO)$/.test(token.text.toUpperCase()))) throw new Error('Export one SELECT query without script batches or write statements. Select the query in the editor first.')
}
