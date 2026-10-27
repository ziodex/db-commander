const { createRequire } = require('node:module')
const { readdir } = require('node:fs/promises')
const { join, normalize } = require('node:path')
const builder = createRequire(require.resolve('electron-builder'))
const lib = createRequire(builder.resolve('app-builder-lib'))
const asar = lib('@electron/asar')
const version = require('../../package.json').dependencies.oracledb
const thick = /(?:^|\/)node_modules\/oracledb\/(?:build(?:\/|$)|.*\.(?:node|dll|dylib|so(?:\.\d+)*)$)/i

async function verifyOracleThinPackage(resources) {
  const archive = join(resources, 'app.asar')
  const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
  const forbidden = files.find(name => thick.test(name))
  if (forbidden) throw new Error(`Oracle Thick-mode payload is outside the supported Thin-only release: ${forbidden}`)
  for (const file of ['index.js', 'lib/thin/connection.js', 'package.json']) {
    const name = `node_modules/oracledb/${file}`
    if (!files.includes(name) || !asar.extractFile(archive, normalize(name)).length) throw new Error(`Oracle Thin-mode package is missing a required entry: ${file}`)
  }
  const metadata = JSON.parse(asar.extractFile(archive, normalize('node_modules/oracledb/package.json')).toString('utf8'))
  if (metadata.name !== 'oracledb' || metadata.version !== version) throw new Error('Review the Oracle Thin-mode package after changing its pinned version.')
  // A stale physical addon must not hide outside the ASAR index. Do not follow
  // directory aliases, and keep inspection bounded independently of input size.
  let visited = 0
  async function visit(relative) {
    let entries
    try { entries = await readdir(join(resources, 'app.asar.unpacked', relative), { withFileTypes: true }) }
    catch (error) { if (!relative && error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (++visited > 20000) throw new Error('Oracle Thin-mode package audit exceeds its file limit.')
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (thick.test(name)) throw new Error(`Oracle Thick-mode physical payload remains outside the ASAR index: ${name}`)
      if (entry.isDirectory()) await visit(name)
    }
  }
  await visit('')
}
module.exports = { verifyOracleThinPackage }
