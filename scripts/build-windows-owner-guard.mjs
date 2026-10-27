import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function buildWindowsOwnerGuard(output) {
  if (process.platform !== 'win32') return
  const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!existsSync(compiler)) throw new Error('Windows builds require the Windows .NET Framework C# compiler for the process ownership helper.')
  mkdirSync(output, { recursive: true })
  const destination = resolve(output, 'windows-owner-guard.exe')
  execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', `/out:${destination}`, resolve('src/main/windows-owner-guard.cs')], { stdio: 'inherit', windowsHide: true })
  const sourceOutput = resolve('out/main'); mkdirSync(sourceOutput, { recursive: true })
  if (resolve(output) !== sourceOutput) copyFileSync(destination, join(sourceOutput, 'windows-owner-guard.exe'))
}
