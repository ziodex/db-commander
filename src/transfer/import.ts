import { openDelimited } from './delimited'
import { openRecords } from './file-source'
import { parseJsonImport } from './json'
import { parseJsonLines } from './jsonl'
import type { ImportSource } from '../shared/transfer'

export function openImport(file: string, format: ImportSource['format']) {
  return format === 'json' ? openRecords(file, parseJsonImport) : format === 'jsonl' ? openRecords(file, parseJsonLines) : openDelimited(file, format)
}
