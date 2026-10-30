import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tlsRoots from 'node:tls'
import { endpoint, isRouted } from '../connections/transport'
import type { ConnectionConfig } from '../shared/contracts'
import type { BackupRequest } from '../shared/backup'
import { openMysqlTransport } from '../driver/mysql-transport'
import { check, quoteIdentifier, validateName, type BackupContext } from './context'
import { header, publishFile } from './files'
import { runTool, type BackupOptions, type ToolCommand } from './tools'
import { inspectNativeTool } from './native-tool'
import { openBackupPostgres } from './postgres'

export async function logicalBackup(config: ConnectionConfig, request: BackupRequest, context: BackupContext, options: BackupOptions) {
  const postgres = config.engine === 'postgres', maria = config.engine === 'mariadb'
  const run = options.runTool ?? runTool
  const { executable, version: toolVersion, major: toolMajor } = await inspectNativeTool(config.engine, request, context, options)
  context.log(`Native tool: ${toolVersion}`)
  const directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'dbcommander-auth-'))
  try {
    const env = { ...process.env }, args: string[] = []
    // Ignore inherited credentials/service settings; only the chosen connection is used.
    for (const key of Object.keys(env)) if (/^(PG|MYSQL|MARIADB)/.test(key)) delete env[key]
    // Native clients do not share Node's default roots automatically. In
    // particular libpq otherwise requires ~/.postgresql/root.crt even when the
    // connection in the workbench already trusts a public CA.
    const verifiedTls = config.tls === 'verify-full'
    const roots = postgres && typeof tlsRoots.getCACertificates === 'function' ? tlsRoots.getCACertificates('default') : tlsRoots.rootCertificates
    if (verifiedTls) await writeFile(join(directory, 'ca.pem'), config.ca || roots.join('\n'), { mode: 0o600 })
    if (postgres) {
      const escape = (s: string) => s.replaceAll('\\', '\\\\').replaceAll(':', '\\:')
      if (/[\r\n]/.test(config.password)) throw new Error('PostgreSQL password files cannot contain line breaks.')
      await writeFile(join(directory, 'pgpass'), [config.host, String(endpoint(config).port), '*', config.user, config.password].map(escape).join(':') + '\n', { mode: 0o600 })
      Object.assign(env, { PGHOST: config.host, PGPORT: String(endpoint(config).port), ...(isRouted(config) ? { PGHOSTADDR: endpoint(config).host } : {}), PGUSER: config.user, PGPASSFILE: join(directory, 'pgpass'), PGSSLMODE: config.tls === 'verify-full' ? 'verify-full' : 'disable', PGCONNECT_TIMEOUT: '15' })
      if (verifiedTls) env.PGSSLROOTCERT = join(directory, 'ca.pem')
      args.push('--no-password')
    } else {
      const value = (s: string) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t') + '"'
      const tls = config.tls === 'verify-full' ? maria ? 'ssl\nssl-verify-server-cert\n' : 'ssl-mode=VERIFY_IDENTITY\n' : maria ? 'skip-ssl\n' : 'ssl-mode=DISABLED\n'
      await writeFile(join(directory, 'client.cnf'), `[client]\nprotocol=TCP\nhost=${value(config.host)}\nport=${config.port}\nuser=${value(config.user)}\npassword=${value(config.password)}\ndefault-character-set=utf8mb4\n${tls}${verifiedTls ? `ssl-ca=${value(join(directory, 'ca.pem'))}\n` : ''}`, { mode: 0o600 })
      args.push(`--defaults-file=${join(directory, 'client.cnf')}`)
      // MySQL's login file is read even with --defaults-file; disable it explicitly.
      if (!maria) args.push('--no-login-paths')
    }
    const pgDatabase = (name: string) => "dbname='" + name.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'"
    const command: ToolCommand = { executable, args, env }
    if (postgres) {
      const client = await openBackupPostgres(config)
      try {
        const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num)
        if (toolMajor !== Math.floor(version / 10000)) throw new Error('Install native PostgreSQL tools matching the target server major version.')
        check(context)
        if (request.action === 'backup') {
          context.log('Creating a consistent PostgreSQL archive.')
          await publishFile(request.artifact, context, file => run({ ...command, args: [...args, '--format=custom', ...(request.content === 'schema' ? ['--schema-only'] : []), `--dbname=${pgDatabase(config.database)}`], output: file }, context).then(() => {}))
        } else {
          if (!(await header(request.artifact, 5)).equals(Buffer.from('PGDMP'))) throw new Error('Choose a PostgreSQL custom-format archive.')
          const listing = await run({ ...command, args: [...args, '--list', request.artifact] }, context)
          const sourceMajor = Number(listing.match(/Dumped from database version:\s*(\d+)/)?.[1])
          if (!sourceMajor || sourceMajor > toolMajor) throw new Error('The archive requires a newer PostgreSQL server/tool version.')
          validateName(request.target!, 63); check(context)
          await client.query(`CREATE DATABASE ${quoteIdentifier(request.target!)} TEMPLATE template0`)
          context.log(`Created new database ${request.target}. A failed restore leaves this target for inspection.`)
          await run({ ...command, args: [...args, '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', `--dbname=${pgDatabase(request.target!)}`, request.artifact] }, context)
        }
      } finally { await client.end().catch(() => {}) }
    } else {
      const client = await openMysqlTransport(config)
      try {
        const version = String((await client.query('SELECT VERSION()'))[0][0])
        if (Number(version.split('.')[0]) !== toolMajor || /mariadb/i.test(version) !== maria) throw new Error('Install native client tools matching the server engine and major version.')
        if (request.action === 'backup') {
          if (request.content === 'all') {
            const tables = await client.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' AND ENGINE<>'InnoDB' LIMIT 1", [config.database])
            if (tables.length) throw new Error('A consistent online backup requires all tables to use InnoDB. Use engine administration tools for nontransactional tables.')
          }
          context.log('Creating SQL dump. Avoid concurrent schema changes until the job finishes.')
          const prefix = `-- Db Commander ${JSON.stringify({ engine: config.engine, version, content: request.content })}\n`
          await publishFile(request.artifact, context, file => run({ ...command, args: [...args, '--single-transaction', '--quick', '--hex-blob', '--routines', '--events', '--triggers', '--skip-add-drop-table', ...(maria ? [] : ['--set-gtid-purged=OFF', '--no-tablespaces', '--column-statistics=0']), ...(request.content === 'schema' ? ['--no-data'] : []), '--', config.database], output: file, prefix }, context).then(() => {}))
        } else {
          const first = (await header(request.artifact)).toString().split('\n')[0]
          let source: { engine: string; version: string }
          try { source = JSON.parse(first.replace(/^-- (?:Db Commander|SQLCommander) /, '')) } catch { throw new Error('Choose a Db Commander SQL dump for this engine.') }
          if (source.engine !== config.engine || Number(String(source.version).split('.')[0]) !== toolMajor) throw new Error('The SQL dump engine or major version does not match this server.')
          validateName(request.target!, 64); check(context)
          const settings = await client.query('SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [config.database])
          const charset = String(settings[0]?.[0] ?? 'utf8mb4'), collation = String(settings[0]?.[1] ?? 'utf8mb4_unicode_ci')
          if (!/^[\w]+$/.test(charset + collation)) throw new Error('Unsupported character set metadata.')
          await client.query('CREATE DATABASE `' + request.target!.replaceAll('`', '``') + '` CHARACTER SET ' + charset + ' COLLATE ' + collation)
          context.log(`Created new database ${request.target}. A failed restore may leave partially committed objects; inspect it before retrying.`)
          await run({ ...command, args: [...args, '--binary-mode', '--local-infile=0', `--database=${request.target}`], input: request.artifact }, context)
        }
      } finally { await client.end().catch(() => {}) }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
