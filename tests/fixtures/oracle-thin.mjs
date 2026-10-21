import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { asar } from './release-inventory.mjs'

export async function seedOracleThinPackage(resources, { files = {}, version = '26.0.0' } = {}) {
  const source = join(resources, 'oracle-thin-fixture')
  const contents = {
    'node_modules/oracledb/package.json': JSON.stringify({ name: 'oracledb', version, main: 'index.js' }),
    'node_modules/oracledb/index.js': 'module.exports = { thin: true }',
    'node_modules/oracledb/lib/thin/connection.js': '// Thin implementation fixture',
    ...files
  }
  for (const [name, value] of Object.entries(contents)) {
    if (value === null) continue
    await mkdir(dirname(join(source, name)), { recursive: true }); await writeFile(join(source, name), value)
  }
  await asar.createPackageWithOptions(source, join(resources, 'app.asar'), { unpack: '*.node' })
}
