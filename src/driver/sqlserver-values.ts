import parser from 'tedious/lib/value-parser'
import { NotEnoughDataError } from 'tedious/lib/token/helpers'
import type { Connection } from 'tedious'

interface Metadata { type: { name: string }; scale?: number }
interface Value { value: string | null; offset: number }
const EXACT = new Set(['NumericN', 'DecimalN', 'Money', 'SmallMoney', 'MoneyN', 'Date', 'Time', 'DateTime2', 'DateTimeOffset', 'DateTime', 'SmallDateTime', 'DateTimeN'])
const variantTypes: Record<number, string> = { 106: 'DecimalN', 108: 'NumericN', 60: 'Money', 122: 'SmallMoney', 40: 'Date', 41: 'Time', 42: 'DateTime2', 43: 'DateTimeOffset', 61: 'DateTime', 58: 'SmallDateTime' }
const DAY = 86400000
const EPOCH = Date.parse('0001-01-01T00:00:00Z')
function need(buffer: Buffer, end: number) { if (buffer.length < end) throw new NotEnoughDataError(end) }
function unsigned(buffer: Buffer, start: number, length: number) {
  let value = 0n
  for (let i = length - 1; i >= 0; i--) value = (value << 8n) | BigInt(buffer[start + i])
  return value
}
export function decimalText(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : ''
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0')
  return sign + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits)
}
function calendar(days: number) { return new Date(EPOCH + days * DAY).toISOString().slice(0, 10) }
function timeText(units: bigint, scale: number) {
  const factor = 10n ** BigInt(scale), seconds = units / factor
  const parts = [seconds / 3600n, seconds / 60n % 60n, seconds % 60n].map(value => String(value).padStart(2, '0')).join(':')
  return parts + (scale ? '.' + String(units % factor).padStart(scale, '0') : '')
}
function payload(buffer: Buffer, offset: number, length: number, name: string, scale = 0): string {
  need(buffer, offset + length)
  if (name === 'NumericN' || name === 'DecimalN') {
    if (![5, 9, 13, 17].includes(length) || scale < 0 || scale > 38) throw new Error('Invalid TDS numeric value.')
    return decimalText(unsigned(buffer, offset + 1, length - 1) * (buffer[offset] === 0 ? -1n : 1n), scale)
  }
  if (['Money', 'SmallMoney', 'MoneyN'].includes(name)) {
    if (length !== 4 && length !== 8) throw new Error('Invalid TDS money value.')
    const value = length === 4 ? BigInt(buffer.readInt32LE(offset)) : (BigInt(buffer.readInt32LE(offset)) << 32n) + BigInt(buffer.readUInt32LE(offset + 4))
    return decimalText(value, 4)
  }
  if (['DateTime', 'SmallDateTime', 'DateTimeN'].includes(name)) {
    if (length !== 4 && length !== 8) throw new Error('Invalid TDS datetime value.')
    const days = length === 4 ? buffer.readUInt16LE(offset) : buffer.readInt32LE(offset)
    const millis = length === 4 ? buffer.readUInt16LE(offset + 2) * 60000 : Math.round(buffer.readUInt32LE(offset + 4) * 1000 / 300)
    return new Date(Date.UTC(1900, 0, 1) + days * DAY + millis).toISOString().slice(0, -1).replace('T', ' ')
  }
  if (name === 'Date') {
    if (length !== 3) throw new Error('Invalid TDS date value.')
    return calendar(buffer.readUIntLE(offset, 3))
  }
  if (scale < 0 || scale > 7) throw new Error('Invalid TDS time scale.')
  const timeLength = length - (name === 'DateTimeOffset' ? 5 : name === 'DateTime2' ? 3 : 0)
  if (![3, 4, 5].includes(timeLength)) throw new Error('Invalid TDS time value.')
  let units = unsigned(buffer, offset, timeLength)
  if (name === 'Time') return timeText(units, scale)
  let days = buffer.readUIntLE(offset + timeLength, 3)
  let suffix = ''
  if (name === 'DateTimeOffset') {
    const minutes = buffer.readInt16LE(offset + timeLength + 3)
    const perDay = 86400n * 10n ** BigInt(scale)
    units += BigInt(minutes) * 60n * 10n ** BigInt(scale)
    if (units < 0) { units += perDay; days-- }
    if (units >= perDay) { units -= perDay; days++ }
    suffix = `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`
  }
  return `${calendar(days)} ${timeText(units, scale)}${suffix}`
}

/** Decode exact fixed-point and temporal TDS values before Tedious converts them
 * to JS Number/Date. Returning undefined delegates all other types to Tedious. */
export function exactTdsValue(buffer: Buffer, offset: number, metadata: Metadata): Value | undefined {
  const name = metadata.type.name
  if (name === 'Variant') {
    need(buffer, offset + 4)
    const length = buffer.readUInt32LE(offset); offset += 4
    if (!length) return { value: null, offset }
    need(buffer, offset + length)
    const type = variantTypes[buffer[offset]], properties = buffer[offset + 1]
    if (!type) return undefined
    const scale = type === 'NumericN' || type === 'DecimalN' ? buffer[offset + 3] : buffer[offset + 2]
    const start = offset + 2 + properties
    return { value: payload(buffer, start, length - properties - 2, type, scale), offset: offset + length }
  }
  if (!EXACT.has(name)) return undefined
  let length = name === 'Money' || name === 'DateTime' ? 8 : name === 'SmallMoney' || name === 'SmallDateTime' ? 4 : undefined
  if (length === undefined) { need(buffer, offset + 1); length = buffer[offset++]; if (!length) return { value: null, offset } }
  return { value: payload(buffer, offset, length, name, metadata.scale), offset: offset + length }
}

let installed = false
export function enableExactTdsValues(connection: Connection) {
  // A single opt-in, version-pinned compatibility hook. There is no public raw
  // value decoder in Tedious. No dependency files or user SQL are modified.
  if (!installed) {
    const original = parser.readValue
    parser.readValue = ((buffer, offset, metadata, options) => {
      if ((options as typeof options & { dbCommanderExactValues?: boolean }).dbCommanderExactValues) {
        const value = exactTdsValue(buffer, offset, metadata)
        if (value) return value
      }
      return original(buffer, offset, metadata, options)
    }) as typeof parser.readValue
    installed = true
  }
  Object.assign(connection.config.options, { dbCommanderExactValues: true })
}
