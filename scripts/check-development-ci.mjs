import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const developmentChecks = [
  ...['darwin-x64', 'darwin-arm64', 'win32-x64', 'linux-x64'].map(target => `Desktop (${target})`),
  ...['sqlserver', 'postgres', 'mysql', 'mariadb', 'sqlite', 'oracle', 'duckdb'].map(driver => `Driver (${driver})`),
  'Full development CI'
]

// Only promote the tested development tree. A green PR run alone cannot qualify
// the later development merge commit, and an untested main-only change cannot
// silently join a promotion. Bring main into development and validate it first.
export async function verifyDevelopmentPromotion({ event, repository, request }) {
  const pr = event.pull_request
  if (pr?.base?.ref !== 'main' || pr.head?.ref !== 'development' || pr.head.repo?.full_name !== repository) {
    throw new Error('Main promotions must come from this repository\'s development branch.')
  }
  const sha = pr.head.sha
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[a-f0-9]{40}$/.test(pr.base.sha ?? '')) throw new Error('Full source and base commits are required.')
  const prefix = `/repos/${repository}`
  const current = await request(`${prefix}/branches/development`)
  if (current.commit?.sha !== sha) throw new Error('Development has changed. Update the promotion PR and rerun its checks.')
  const comparison = await request(`${prefix}/compare/${pr.base.sha}...${sha}`)
  if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Merge main into development and pass full CI before promoting the combined tree.')

  const { workflow_runs: runs = [] } = await request(`${prefix}/actions/workflows/ci.yml/runs?event=push&branch=development&head_sha=${sha}&per_page=100`)
  const run = runs.filter(item => item.head_sha === sha && item.head_branch === 'development' && item.event === 'push' && item.path === '.github/workflows/ci.yml')
    .sort((a, b) => b.run_number - a.run_number)[0]
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Full push CI must pass for this exact development commit before promotion. Wait for it, then rerun this check.')
  }
  const { jobs = [], total_count = jobs.length } = await request(`${prefix}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
  if (total_count > 100 || developmentChecks.some(name => !jobs.some(job => job.name === name && job.status === 'completed' && job.conclusion === 'success'))) {
    throw new Error('Development CI must include every successful desktop and driver target, plus Full development CI.')
  }
  // Do not certify an older head if development advanced during inspection.
  if ((await request(`${prefix}/branches/development`)).commit?.sha !== sha) throw new Error('Development changed during validation. Rerun this check.')
  return { sha, runId: run.id }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !process.env.GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY ?? '')) throw new Error('A GitHub pull request context and read token are required.')
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const request = async path => {
    const response = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
      headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`Cannot verify development CI: GitHub returned HTTP ${response.status}.`)
    return response.json()
  }
  const result = await verifyDevelopmentPromotion({ event, repository: process.env.GITHUB_REPOSITORY, request })
  console.log(`Development ${result.sha} passed full push CI in run ${result.runId}.`)
}
