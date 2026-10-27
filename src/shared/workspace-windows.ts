import { z } from 'zod'

export const workspaceWindowIdSchema = z.union([z.literal('primary'), z.uuid()])
export const workspaceWindowNameSchema = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/)
export const workspaceWindowSchema = z.object({ id: workspaceWindowIdSchema, name: workspaceWindowNameSchema }).strict()
export type WorkspaceWindow = z.infer<typeof workspaceWindowSchema>
export type WorkspaceWindows = { currentId: string; windows: (WorkspaceWindow & { open: boolean })[] }
export const MAX_OPEN_WINDOWS = 8
export const MAX_SAVED_WINDOWS = 32
