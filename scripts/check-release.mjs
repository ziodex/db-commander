import { nativeTarget, isMain } from './release/common.mjs'
import { parseArgs } from 'node:util'

export function validateReleaseGate(env, armPool) {
  if (env.BUILD_SOURCEBRANCH !== 'refs/heads/main') throw new Error('Releases are restricted to main.')
  if (!/^[a-f0-9]{40}$/.test(env.BUILD_SOURCEVERSION || '')) throw new Error('A full source commit is required.')
  if (!armPool?.trim()) throw new Error('Configure macArmPool: a native Apple Silicon agent is required for all four release targets.')
}
if (isMain(import.meta)) {
  const { values } = parseArgs({ options: { arch: { type: 'string' }, 'release-gate': { type: 'boolean' }, 'arm-pool': { type: 'string' } } })
  if (values['release-gate']) validateReleaseGate(process.env, values['arm-pool'])
  else await nativeTarget(values.arch)
}
