import { spawnSync } from 'node:child_process'
const result = spawnSync('docker', ['compose', 'exec', '-T', 'sqlserver', '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-P', 'Local-SA-Only!2026', '-C', '-b', '-i', '/tmp/dbcommander-init.sql'], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
