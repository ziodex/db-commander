import { expect, it } from 'vitest'
import { compileParameters, parametersSchema, timestampTzValue, type QueryParameter } from '../../src/shared/parameters'
import { boundValue } from '../../src/driver/parameters'
import { engineSchema } from '../../src/shared/contracts'

const parameter = (value: string): QueryParameter => ({ name: 'moment', type: 'timestamptz', value })
it('normalizes fixed offsets without losing fractions across calendar and DST boundaries', () => {
  const cases = [
    ['2026-10-25T02:30:00.123456+02:00','2026-10-25T00:30:00.123456+00:00'],
    ['2026-10-25 02:30:00.123456+01:00','2026-10-25T01:30:00.123456+00:00'],
    ['2026-01-01T00:15:00.000001+05:45','2025-12-31T18:30:00.000001+00:00'],
    ['2000-03-01T00:00:00+00:01','2000-02-29T23:59:00.000000+00:00'],
    ['1900-03-01T00:00:00+00:01','1900-02-28T23:59:00.000000+00:00'],
    ['2040-02-29T23:59:59.999999-00:01','2040-03-01T00:00:59.999999+00:00'],
    ['2025-12-31T23:59:59.1-03:30','2026-01-01T03:29:59.100000+00:00'],
    ['1000-01-01T14:00:00+14:00','1000-01-01T00:00:00.000000+00:00'],
    ['9999-12-31T09:59:59.999999-14:00','9999-12-31T23:59:59.999999+00:00'],
    ['2026-03-29T02:30:00Z','2026-03-29T02:30:00.000000+00:00'],
    ['2026-03-29T02:30:00.123456+00:00','2026-03-29T02:30:00.123456+00:00']
  ]
  for (const [input, expected] of cases) {
    expect(parametersSchema.safeParse([parameter(input)]).success, input).toBe(true)
    expect(timestampTzValue(input)).toBe(expected); expect(boundValue(parameter(input))).toBe(expected)
    expect(timestampTzValue(expected)).toBe(expected)
  }
})
it('rejects missing, ambiguous, out-of-range and malformed timezone values without exposing their contents', () => {
  for (const input of ['2026-10-25 02:30:00','2026-10-25 02:30:00 Europe/Madrid','2026-10-25T02:30:00-00:00',
    '2026-01-01T00:00:00+14:01','2026-01-01T00:00:00-14:01','2026-01-01T00:00:00+15:00','2026-01-01T00:00:00+05:60',
    '2026-01-01T00:00:00+0530','2026-01-01T00:00:00+5:30','2026-01-01T00:00:00z','2026-01-01T00:00Z',
    '2026-02-29T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T23:59:60Z','2026-01-01T00:00:00.1234567Z',
    '0999-12-31T23:59:59Z','1000-01-01T00:00:00+00:01','9999-12-31T23:59:59-00:01',
    '2026-01-01T00:00:00Z\n',' 2026-01-01T00:00:00Z',"2026-01-01T00:00:00Z'; DROP TABLE t; --"]) {
    const result = parametersSchema.safeParse([parameter(input)])
    expect(result.success, input).toBe(false); expect(() => timestampTzValue(input)).toThrow(/Timestamp with timezone/)
    if (!result.success) expect(result.error.issues[0].message).not.toContain(input)
  }
})
it('agrees with an independent UTC epoch oracle across all minute offsets and leap/century rollovers', () => {
  // Date is only the independent test oracle; production keeps microseconds as text.
  for (const day of ['1900-03-01','2000-03-01','2026-01-01','2040-02-29']) for (let minutes = -840; minutes <= 840; minutes++) {
    const offset = (minutes < 0 ? '-' : '+') + String(Math.floor(Math.abs(minutes) / 60)).padStart(2,'0') + ':' + String(Math.abs(minutes) % 60).padStart(2,'0')
    const input = day + 'T00:15:59.123456' + offset
    expect(timestampTzValue(input)).toBe(new Date(Date.parse(day + 'T00:15:59Z') - minutes * 60000).toISOString().slice(0,19) + '.123456+00:00')
  }
})
for (const engine of engineSchema.options) it(`binds timezone timestamps as data using ${engine} conversions`, () => {
  const p = parameter('2040-02-29T00:00:00.000001+05:45'), result = compileParameters('SELECT :moment, :moment',engine,[p])
  expect(result.values).toEqual([p,p]); expect(result.sql).not.toContain(p.value); expect(result.sql).not.toContain('2040-02-28')
  const conversion = engine === 'oracle' ? 'FROM_TZ(TO_TIMESTAMP' : ['sqlserver','azure-sql'].includes(engine) ? 'DATETIMEOFFSET(6)' : ['mysql','mariadb'].includes(engine) ? 'DATETIME(6)' : engine === 'sqlite' ? 'TEXT' : engine === 'postgres' ? 'TIMESTAMP(6) WITH TIME ZONE' : 'TIMESTAMPTZ'
  expect(result.sql).toContain(conversion)
  expect(result.values.map(boundValue)).toEqual(['2040-02-28T18:15:00.000001+00:00','2040-02-28T18:15:00.000001+00:00'])
  expect(() => compileParameters('SELECT :moment',engine,[parameter('2026-10-25T02:30:00')])).toThrow(/Timestamp with timezone/)
})
