interface WorkerPaths {
  dirname(value: string): string
  basename(value: string): string
  join(...values: string[]): string
}

/** Native child processes need ordinary resource files outside app.asar. */
export function physicalWorkerPath(directory: string, name: string, paths: WorkerPaths): string {
  const output = paths.dirname(directory), archive = paths.dirname(output)
  return paths.basename(directory) === 'main' && paths.basename(output) === 'out' && paths.basename(archive) === 'app.asar'
    ? paths.join(paths.dirname(archive), 'workers', name)
    : paths.join(directory, name)
}
