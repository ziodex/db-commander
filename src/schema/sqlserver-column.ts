import type { CatalogSection } from '../shared/catalog'

export function sqlServerCurrentType(section: CatalogSection, row: (string | null)[], quote: (name: string) => string) {
  const get = (name: string) => { const position = section.columns.indexOf(name); if (position < 0) throw new Error('Column metadata is incomplete. Inspect its definition and use explicit SQL.'); return row[position] }
  const unsafe = ['Sparse', 'Column set', 'Filestream', 'Generated always', 'Hidden', 'Masked', 'Encryption', 'XML schema collection']
  for (const flag of unsafe) {
    const value = get(flag)
    if (value === undefined || value === null && flag !== 'Encryption') throw new Error('Column alteration metadata is incomplete. Inspect its definition and use explicit SQL.')
    if (value !== null && value !== '0' && value !== 'false') throw new Error(`This column has ${flag.toLowerCase()} attributes that cannot safely be reconstructed here. Use reviewed SQL.`)
  }
  const originalType = get('Type'), type = originalType?.toLowerCase(), user = get('User-defined'), schema = get('Type schema'), collation = get('Collation')
  if (!type || user == null || !schema) throw new Error('Column type metadata is incomplete. Inspect its definition and use explicit SQL.')
  if (!['0','1','false','true'].includes(user.toLowerCase())) throw new Error('Column type metadata is incomplete. Inspect its definition and use explicit SQL.')
  if (user === '1' || user.toLowerCase() === 'true') {
    if (collation) throw new Error('A collated user-defined type cannot safely be reconstructed here. Use reviewed SQL.')
    return { sql: `${quote(schema)}.${quote(originalType!)}`, collation: null }
  }
  const simple = ['tinyint','smallint','int','bigint','bit','real','money','smallmoney','date','datetime','smalldatetime','uniqueidentifier','xml']
  if (simple.includes(type)) return { sql: type.toUpperCase(), collation: null }
  if (type === 'float') {
    const precision = Number(get('Precision')); if (!Number.isInteger(precision) || precision < 1 || precision > 53) throw new Error('Float precision metadata is incomplete.')
    return { sql: `FLOAT(${precision})`, collation: null }
  }
  if (['decimal','numeric'].includes(type)) {
    const precision = Number(get('Precision')), scale = Number(get('Scale'))
    if (!Number.isInteger(precision) || precision < 1 || precision > 38 || !Number.isInteger(scale) || scale < 0 || scale > precision) throw new Error('Numeric type metadata is incomplete.')
    return { sql: `${type.toUpperCase()}(${precision},${scale})`, collation: null }
  }
  if (['time','datetime2','datetimeoffset'].includes(type)) {
    const rawScale = get('Scale'), scale = Number(rawScale); if (rawScale == null || !Number.isInteger(scale) || scale < 0 || scale > 7) throw new Error('Temporal precision metadata is incomplete.')
    return { sql: `${type.toUpperCase()}(${scale})`, collation: null }
  }
  if (['char','varchar','nchar','nvarchar','binary','varbinary'].includes(type)) {
    const length = Number(get('Length (bytes)')), unicode = type.startsWith('n'), maximum = length === -1
    if (!Number.isInteger(length) || length === 0 || length < -1 || unicode && !maximum && length % 2) throw new Error('Column length metadata is incomplete.')
    if (['char','varchar','nchar','nvarchar'].includes(type) && !collation) throw new Error('Column collation metadata is incomplete.')
    if (collation && !/^[A-Za-z0-9_]+$/.test(collation)) throw new Error('Column collation metadata is invalid. Inspect its definition and use explicit SQL.')
    return { sql: `${type.toUpperCase()}(${maximum ? 'MAX' : unicode ? length / 2 : length})`, collation }
  }
  throw new Error(`The existing ${type} type cannot safely be reconstructed here. Use reviewed SQL.`)
}
