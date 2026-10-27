import { describe, expect, it, vi } from 'vitest'
import { developmentChecks, verifyDevelopmentPromotion } from '../../scripts/check-development-ci.mjs'

const sha = 'a'.repeat(40), base = 'b'.repeat(40), repository = 'owner/db-commander'
function fixture() {
  const event = { pull_request: { base: { ref: 'main', sha: base }, head: { ref: 'development', sha, repo: { full_name: repository } } } }
  const run = { id: 42, run_number: 9, head_sha: sha, head_branch: 'development', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' }
  const data = {
    [`/repos/${repository}/branches/development`]: { commit: { sha } },
    [`/repos/${repository}/compare/${base}...${sha}`]: { status: 'ahead' },
    [`/repos/${repository}/actions/workflows/ci.yml/runs?event=push&branch=development&head_sha=${sha}&per_page=100`]: { workflow_runs: [run] },
    [`/repos/${repository}/actions/runs/42/jobs?filter=latest&per_page=100`]: { jobs: developmentChecks.map(name => ({ name, status: 'completed', conclusion: 'success' })) }
  }
  const request = vi.fn(async path => { if (!(path in data)) throw new Error(`Unexpected request: ${path}`); return data[path] })
  return { event, repository, request, data, run }
}

describe('development promotion gate', () => {
  it('accepts the exact current development commit only after full push qualification', async () => {
    const f = fixture()
    await expect(verifyDevelopmentPromotion(f)).resolves.toEqual({ sha, runId: 42 })
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/branches/development'))).toHaveLength(2)
  })
  it('refuses topic branches, forks and another base branch before reading CI', async () => {
    for (const change of [f => { f.event.pull_request.head.ref = 'topic' }, f => { f.event.pull_request.head.repo.full_name = 'fork/repo' }, f => { f.event.pull_request.base.ref = 'development' }]) {
      const f = fixture(); change(f)
      await expect(verifyDevelopmentPromotion(f)).rejects.toThrow('must come from')
      expect(f.request).not.toHaveBeenCalled()
    }
  })
  it('refuses stale heads and main-only merge changes that development has not tested', async () => {
    const stale = fixture(); stale.event.pull_request.head.sha = 'c'.repeat(40)
    await expect(verifyDevelopmentPromotion(stale)).rejects.toThrow('has changed')
    for (const status of ['diverged', 'behind']) {
      const f = fixture(); f.data[`/repos/${repository}/compare/${base}...${sha}`].status = status
      await expect(verifyDevelopmentPromotion(f)).rejects.toThrow('Merge main into development')
    }
  })
  it('does not accept a green PR, a different commit/workflow, or missing push CI', async () => {
    for (const change of [r => { r.event = 'pull_request' }, r => { r.head_sha = base }, r => { r.path = '.github/workflows/other.yml' }, r => { r.head_branch = 'topic' }]) {
      const f = fixture(); change(f.run)
      await expect(verifyDevelopmentPromotion(f)).rejects.toThrow('Full push CI must pass')
    }
    const f = fixture(); Object.values(f.data).find(value => value.workflow_runs).workflow_runs = []
    await expect(verifyDevelopmentPromotion(f)).rejects.toThrow('Full push CI must pass')
  })
  it('requires the latest run to finish successfully, even if an older run passed', async () => {
    for (const [status, conclusion] of [['in_progress', null], ['queued', null], ['completed', 'failure'], ['completed', 'cancelled']]) {
      const f = fixture()
      Object.values(f.data).find(value => value.workflow_runs).workflow_runs.push({ ...f.run, id: 43, run_number: 10, status, conclusion })
      await expect(verifyDevelopmentPromotion(f)).rejects.toThrow('Full push CI must pass')
    }
  })
  it('requires all matrix entries and the aggregate to pass rather than accepting skips', async () => {
    for (const name of developmentChecks) for (const conclusion of ['skipped', 'failure', 'cancelled', null]) {
      const f = fixture()
      const { jobs } = Object.values(f.data).find(value => value.jobs)
      jobs.find(job => job.name === name).conclusion = conclusion
      await expect(verifyDevelopmentPromotion(f)).rejects.toThrow('every successful desktop and driver')
    }
    const f = fixture(); Object.values(f.data).find(value => value.jobs).jobs.pop()
    await expect(verifyDevelopmentPromotion(f)).rejects.toThrow('every successful desktop and driver')
  })
  it('fails closed on API errors and a development update during inspection', async () => {
    const f = fixture(); f.request.mockRejectedValueOnce(new Error('API unavailable'))
    await expect(verifyDevelopmentPromotion(f)).rejects.toThrow('API unavailable')
    const updated = fixture(); const original = updated.request.getMockImplementation(); let reads = 0
    updated.request.mockImplementation(path => path.endsWith('/branches/development') && ++reads === 2 ? { commit: { sha: base } } : original(path))
    await expect(verifyDevelopmentPromotion(updated)).rejects.toThrow('changed during validation')
  })
})
