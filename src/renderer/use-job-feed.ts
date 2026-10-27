import { useEffect, useEffectEvent, useState } from 'react'

/** Merge the initial list with live events without letting an older list win. */
export function useJobFeed<Job extends { id: string }>(
  subscribe: (receive: (job: Job) => void) => () => void,
  load: () => Promise<Job[]>,
  onJob: (job: Job) => void
) {
  const [jobs, setJobs] = useState<Job[]>([])
  const receivedJob = useEffectEvent(onJob)
  useEffect(() => {
    let disposed = false
    let received: Set<string> | undefined = new Set()
    const receive = (job: Job) => {
      if (disposed) return
      received?.add(job.id)
      setJobs(previous => [...previous.filter(item => item.id !== job.id), job].slice(-40))
      receivedJob(job)
    }
    const unsubscribe = subscribe(receive)
    void load().then(initial => {
      const observed = received
      received = undefined
      initial.filter(job => !observed?.has(job.id)).forEach(receive)
    }).catch(() => {}).finally(() => { received = undefined })
    return () => { disposed = true; received = undefined; unsubscribe() }
  }, [subscribe, load])
  return jobs
}
