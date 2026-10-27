// Test-only executable shim. Desktop uses its ordinary production subprocess
// path; this runs the real client inside the isolated database fixture image.
const { spawn, spawnSync } = require('node:child_process')
const { dirname, isAbsolute } = require('node:path')
const { readFileSync, writeFileSync } = require('node:fs')
module.exports = ({ engine, container, image, tool }) => {
  const args = process.argv.slice(2), env = { ...process.env }, volumes = new Set()
  if (env.PGPASSFILE) {
    volumes.add(dirname(env.PGPASSFILE))
    writeFileSync(env.PGPASSFILE, readFileSync(env.PGPASSFILE, 'utf8').replace(`localhost:${env.PGPORT}:`, 'localhost:5432:'), { mode: 0o600 })
    env.PGPORT = '5432'
  }
  if (args[0]?.startsWith('--defaults-file=')) {
    volumes.add(dirname(args[0].slice('--defaults-file='.length)))
    args.splice(engine === 'mysql' ? 2 : 1, 0, '--port=3306')
  }
  for (const arg of args) if (isAbsolute(arg)) volumes.add(dirname(arg))
  const environment = Object.entries(env).filter(([key]) => key.startsWith('PG')).flatMap(([key, value]) => ['--env', `${key}=${value}`])
  const name = `dbcommander-native-tool-${process.pid}`
  const child = spawn('docker', ['run', '--rm', '-i', '--name', name, '--network', `container:${container}`, ...[...volumes].flatMap(path => ['--volume', `${path}:${path}`]), ...environment, '--entrypoint', tool, image, ...args], { stdio: 'inherit' })
  process.on('SIGTERM', () => { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); process.exit(143) })
  child.on('error', () => { process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
}
