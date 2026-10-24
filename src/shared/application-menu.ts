import { z } from 'zod'

export interface ApplicationMenuItem {
  path: string
  label: string
  enabled: boolean
  type: 'normal' | 'separator' | 'checkbox' | 'radio' | 'submenu'
  checked: boolean
  accelerator?: string
  items?: ApplicationMenuItem[]
}

export const menuPathSchema = z.string().regex(/^\d{1,2}(\/\d{1,2}){0,5}$/)
export const titleBarAppearanceSchema = z.enum(['dark', 'light'])
export type TitleBarAppearance = z.infer<typeof titleBarAppearanceSchema>
