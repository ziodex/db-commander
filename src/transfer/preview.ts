import { dataFileSchema, type DataFilePreview } from '../shared/transfer'
import { openImport } from './import'

export async function inspectDataFile(input: unknown): Promise<DataFilePreview> {
  const request = dataFileSchema.parse(input), source = await openImport(request.file, request.format)
  try {
    const rows = []
    for await (const row of source.records) {
      if (row.length !== source.headers.length) throw new Error('A preview record has a different number of columns than the header.')
      rows.push(row); if (rows.length === 10) break
    }
    if (!await source.unchanged()) throw new Error('The file changed during preview. Preview it again.')
    return { headers: source.headers, rows }
  } finally { await source.close() }
}
