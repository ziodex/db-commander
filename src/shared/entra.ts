import { z } from 'zod'

export const entraProfileSchema = z.object({ tenantId: z.uuid(), clientId: z.uuid() }).strict()
export type EntraProfile = z.infer<typeof entraProfileSchema>

export function azureSqlPublicHost(host: string) {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,3}database\.windows\.net$/i.test(host)
}

export const entraAttemptSchema = z.object({ id: z.uuid(), surface: z.enum(['dialog', 'workspace']) }).strict()
export type EntraAttempt = z.infer<typeof entraAttemptSchema>
export type EntraProgress = EntraAttempt & { phase: 'opening' | 'browser' | 'finishing' | 'finished' }

export const entraProgressText = {
  opening: 'Opening your browser for Microsoft Entra sign-in…',
  browser: 'Finish Microsoft Entra sign-in in your browser.',
  finishing: 'Finishing Microsoft Entra sign-in…'
} as const
