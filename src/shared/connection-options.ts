import { z } from 'zod'

const host = z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9_.:%-]+$/, 'Enter a hostname or IP address, without a URL or shell syntax.')
export const sshSchema = z.object({
  host, port: z.number().int().min(1).max(65535), user: z.string().trim().min(1).max(255),
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, 'Enter the trusted SHA256 host-key fingerprint without trailing = padding.'),
  authentication: z.enum(['password', 'private-key', 'agent']), privateKeyPath: z.string().max(4096).optional(), destinationHost: host.optional()
}).strict()
export const sshSecretsSchema = z.object({ password: z.string().max(4096).optional(), passphrase: z.string().max(4096).optional() }).strict()
const environmentSchema = z.enum(['development', 'test', 'staging', 'production'])
export const profileOptions = {
  recordHistory: z.boolean().optional(),
  folder: z.string().trim().max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Folder names cannot contain control characters.').optional(),
  favorite: z.boolean().optional(), environment: environmentSchema.optional(), protected: z.boolean().optional(), ssh: sshSchema.optional()
}
export function protectedProfile(config: { environment?: string; protected?: boolean }) { return config.environment === 'production' || config.protected === true }
export interface ConnectionSafety { environment?: z.infer<typeof environmentSchema>; protected: boolean; unlockedUntil: number; ssh?: { host: string; port: number; fingerprint: string } }
