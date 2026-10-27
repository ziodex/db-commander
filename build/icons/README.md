# Db Commander icons

The editable SVG master combines a database cylinder and command prompt on a
mint tile (`#a6dfc1`) with an ink mark (`#182a2b`). The broad silhouette and
open counters keep it recognizable at small desktop sizes. No font is required.

Run `pnpm icons` to regenerate every committed PNG size, the Windows ICO,
macOS ICNS, and monochrome tray images using the pinned Electron rasterizer.
No graphics packages or network downloads are required. The SVG is the source
of truth; do not edit generated platform files independently.

`scripts/release/config.cjs` selects the platform icons and copies the 1024px
PNG for runtime windows. macOS development launches also set the Dock icon;
packaged macOS applications use `icon.icns` from their bundle.

`tray.svg` supplies the transparent monochrome database-and-command mark.
The generator writes `trayTemplate.png` (18px) and `trayTemplate@2x.png` (36px);
Electron marks them as templates for light and dark macOS menu bars. Windows
and Linux use the colored runtime icon. All runtime assets ship in packages.
SVGs render through a hidden Chromium canvas without a visible compositor.
