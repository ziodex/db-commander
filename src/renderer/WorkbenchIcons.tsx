import type { ComponentProps } from 'react'

// VS Code product icons use the Codicon font already bundled by Monaco.
// Material Icon Theme supplies file/object icons in MaterialIcon.tsx.
type IconProps = ComponentProps<'span'> & { size?: number; fill?: string }
function icon(glyph: number) {
  return function WorkbenchIcon({ size = 16, fill: _fill, className = '', style, ...props }: IconProps) {
    return <span {...props} aria-hidden="true" data-glyph={String.fromCodePoint(glyph)} className={`workbench-icon ${className}`} style={{ fontSize: size, width: size, height: size, ...style }}/>
  }
}

export const PanelLeft = icon(0xebf3)
export const PanelBottom = icon(0xebf2)
export const Maximize2 = icon(0xeb4c)
export const Minimize2 = icon(0xeb4d)
export const Search = icon(0xea6d)
export const Activity = icon(0xeb31)
export const ArrowDownToLine = icon(0xea78)
export const Save = icon(0xeb4b)
export const Check = icon(0xeab2)
export const Database = icon(0xeace)
export const FolderOpen = icon(0xeaf7)
export const History = icon(0xea82)
export const LockKeyhole = icon(0xea75)
export const Play = icon(0xeb2c)
export const Plus = icon(0xea60)
export const Settings2 = icon(0xeb51)
export const Square = icon(0xead7)
export const Table2 = icon(0xebb7)
export const Terminal = icon(0xea85)
export const Unplug = icon(0xead0)
export const X = icon(0xea76)
export const ChevronDown = icon(0xeab4)
export const ChevronRight = icon(0xeab6)
export const RefreshCw = icon(0xeb37)
export const MoreHorizontal = icon(0xea7c)
export const Pin = icon(0xeba0)
export const ArrowUpRight = icon(0xeb14)
export function Star({ fill, ...props }: IconProps) {
  const Glyph = fill && fill !== 'none' ? FilledStar : EmptyStar
  return <Glyph {...props}/>
}
const EmptyStar = icon(0xea6a), FilledStar = icon(0xeb59)
