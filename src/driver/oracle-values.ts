import oracledb from 'oracledb'

interface DateBuffer {
  caps?: { dbTzOffset?: number | null; dbTzRegion?: string | null }
  parseOracleDate(bytes: Buffer, local?: boolean, databaseTimezone?: boolean): unknown
}
const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** TTC dates contain calendar bytes and up to nine fractional digits. Zoned
 * timestamps arrive in UTC plus an offset/region; LTZ arrives in DBTIMEZONE.
 * Keep the fraction separate from JS Date, which is used only for calendar math.
 */
export function oracleDateText(bytes: Buffer, databaseTimezone = false, caps?: DateBuffer['caps']): string {
  if (![7, 11, 13].includes(bytes.length)) throw new Error('Unexpected Oracle date encoding.')
  const year = (bytes[0] - 100) * 100 + bytes[1] - 100
  const fraction = bytes.length >= 11 ? bytes.readUInt32BE(7) : 0
  if (fraction > 999999999) throw new Error('Invalid Oracle timestamp fraction.')
  const date = new Date(0)
  date.setUTCFullYear(year < 0 ? year + 1 : year, bytes[2] - 1, bytes[3])
  date.setUTCHours(bytes[4] - 1, bytes[5] - 1, bytes[6] - 1, 0)
  let suffix = ''
  if (databaseTimezone) {
    if (caps?.dbTzRegion) throw new Error('Oracle LTZ with a named DBTIMEZONE requires an explicit TO_CHAR conversion.')
    date.setTime(date.getTime() - (caps?.dbTzOffset ?? 0) * 60000)
    suffix = ' +00:00'
  } else if (bytes.length === 13) {
    // Named-region IDs are Oracle-version-specific. Display the exact UTC
    // instant, not an offset guessed using the desktop's different tz database.
    const offset = bytes[11] & 0x80 ? 0 : (bytes[11] - 20) * 60 + bytes[12] - 60
    if (Math.abs(offset) > 14 * 60) throw new Error('Invalid Oracle timestamp offset.')
    date.setTime(date.getTime() + offset * 60000)
    suffix = ` ${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  }
  const calendarYear = date.getUTCFullYear()
  const calendar = `${pad(calendarYear <= 0 ? 1 - calendarYear : calendarYear, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  return `${calendar} ${time}${bytes.length >= 11 ? '.' + pad(fraction, 9) : ''}${suffix}${calendarYear <= 0 ? ' BC' : ''}`
}

/** Pinned, per-connection compatibility hook. Thin mode's public STRING fetch
 * first constructs a JS Date, losing fractions, offsets and years 1–99. Hook the
 * instance's decoder before that conversion; never mutate a shared prototype.
 * Revalidate this contract before upgrading node-oracledb.
 */
export function enableExactOracleDates(connection: oracledb.Connection) {
  const buffer = (connection as unknown as { _impl?: { _protocol?: { readBuf?: DateBuffer } } })._impl?._protocol?.readBuf
  if (oracledb.versionString !== '26.0.0' || !connection.thin || typeof buffer?.parseOracleDate !== 'function') {
    throw new Error('Oracle exact-date compatibility check failed. Revalidate the pinned driver before use.')
  }
  buffer.parseOracleDate = function (bytes, _local, databaseTimezone = false) {
    return oracleDateText(bytes, databaseTimezone, this.caps)
  }
}
