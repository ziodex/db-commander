import path from 'node:path'
import { physicalWorkerPath } from '../shared/physical-worker'

/** Child Node processes must load physical files: Electron's Linux ASAR
 * loader cannot resolve entries below a non-ASCII installation directory. */
export function sqliteWorkerPath(directory: string, paths = path): string {
  return physicalWorkerPath(directory, 'sqlite-worker.cjs', paths)
}
