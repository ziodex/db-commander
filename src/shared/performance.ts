import { z } from 'zod'
import { engineSchema } from './database-engines'

const metric = z.object({
  label: z.string().min(1).max(100),
  value: z.string().max(64).regex(/^\d+(?:\.\d+)?$/),
  unit: z.enum(['count', 'bytes', 'ms', '%']),
  basis: z.enum(['current', 'cumulative', 'interval'])
}).strict()

export const performanceSnapshotSchema = z.object({
  engine: engineSchema,
  database: z.string().max(512),
  capturedAt: z.string().datetime(),
  scope: z.string().max(200),
  status: z.enum(['available', 'unavailable']),
  metrics: z.array(metric).max(12),
  note: z.string().max(500),
  reference: z.string().max(120).optional()
}).strict().refine(snapshot => (snapshot.status === 'available') === (snapshot.metrics.length > 0))

export type PerformanceSnapshot = z.infer<typeof performanceSnapshotSchema>
