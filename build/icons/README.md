# Db Commander icons

The editable SVG master combines a database cylinder and command prompt on a
mint tile (`#a6dfc1`) with an ink mark (`#182a2b`). The broad silhouette and
open counters keep it recognizable at small desktop sizes. No font is required.

Run `pnpm icons` to regenerate every committed PNG size, the Windows ICO,
macOS ICNS, and monochrome tray images using the pinned Electron rasterizer.
No graphics packages or network downloads are required. The SVG is the source
of truth; do not edit generated platform files independently.

`scripts/release/config.cjs` selects the platform icons and copies the 1024px
PNG for runtime windows. Packaged macOS apps include `icon.icns` as a fallback
and an Icon Composer catalog for the native Dock and Finder appearances. Edit
`../macos-icon/DbCommanderIcon.icon` in Icon Composer and run `pnpm icons:mac`
with Xcode 26 or later to compile `Assets.car`. Packaging uses the committed
catalog, so it does not need to run the icon compiler.

The Icon Composer Mono appearance (the `tinted` specialization in `icon.json`)
supplies the white glass mark for Clear and Tinted in both Light and Dark.

`tray.svg` supplies the transparent monochrome database-and-command mark.
The generator writes `trayTemplate.png` (18px) and `trayTemplate@2x.png` (36px);
Electron marks them as templates for light and dark macOS menu bars. Windows
and Linux use the colored runtime icon. All runtime assets ship in packages.
SVGs render through a hidden Chromium canvas without a visible compositor.
