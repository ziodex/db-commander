export interface BackupContext {
  signal: AbortSignal
  log(message: string): void
}
export const quoteIdentifier = (name: string) => '"' + name.replaceAll('"', '""') + '"'
export const quoteLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'"
export function check(context: BackupContext) { context.signal.throwIfAborted() }
export function validateName(value: string, max: number) {
  if (!value || Buffer.byteLength(value) > max || /[\u0000-\u001f]/.test(value)) throw new Error(`Choose a database name of at most ${max} bytes without control characters.`)
}
