import { githubBuildId, nativeTarget, isMain } from './release/common.mjs'
import { parseArgs } from 'node:util'

export function validateReleaseGate(env) {
  if (env.GITHUB_REF !== 'refs/heads/main') throw new Error('Releases are restricted to main.')
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Signed releases require an explicit GitHub Actions workflow_dispatch run.')
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('A full source commit is required.')
  githubBuildId(env)
  if (env.SQLCOMMANDER_RELEASE_GATE !== 'main-ci-passed') throw new Error('Signed releases require successful desktop and driver jobs in the same main CI run.')
}
if (isMain(import.meta)) {
  const { values } = parseArgs({ options: { arch: { type: 'string' }, 'release-gate': { type: 'boolean' } } })
  if (values['release-gate']) validateReleaseGate(process.env)
  else await nativeTarget(values.arch)
}
