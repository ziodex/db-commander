import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function buildWindowsSqlServer(output) {
  if (process.platform !== 'win32') return
  const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  mkdirSync(output, { recursive: true })
  const destination = resolve(output, 'windows-sqlserver.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Data.dll', '/reference:System.Web.Extensions.dll', `/out:${destination}`, resolve('src/driver/windows-sqlserver.cs')], { stdio: 'inherit', windowsHide: true })
  const sourceOutput = resolve('out/main'); mkdirSync(sourceOutput, { recursive: true })
  if (resolve(output) !== sourceOutput) copyFileSync(destination, join(sourceOutput, 'windows-sqlserver.exe'))
}
