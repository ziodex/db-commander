import { z } from 'zod'

export const entraProfileSchema = z.object({ tenantId: z.uuid(), clientId: z.uuid() }).strict()
export type EntraProfile = z.infer<typeof entraProfileSchema>

export function azureSqlPublicHost(host: string) {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,3}database\.windows\.net$/i.test(host)
}
