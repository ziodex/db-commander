import { openDelimited } from './delimited'
import { openRecords } from './file-source'
import { parseJsonImport } from './json'
import type { ImportSource } from '../shared/transfer'

export function openImport(file: string, format: ImportSource['format']) {
  return format === 'json' ? openRecords(file, parseJsonImport) : openDelimited(file, format)
}
