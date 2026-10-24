# VS Code 2026 Dark

`vscode-dark-2026.json` is the resolved original VS Code 1.142.0 theme, copied from the installed VS Code `extensions/theme-defaults/themes/` sources. It merges colors and concatenates token rules in inheritance order: `dark_vs.json`, `dark_plus.json`, `dark_modern.json`, `2026-dark.json`. Later rules take precedence. Color values and TextMate rules are retained without palette adjustments.

Source: https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/2026-dark.json. Licensed under MIT; see `LICENSE.txt`.

The same JSON feeds the CSS custom properties and Monaco theme. `vscode-dark-2026.ts` maps Monaco's SQL Monarch token names to the corresponding upstream TextMate scopes. `vscode-dark-2026.css` assigns the workbench roles. App layout and SQL behavior remain specific to Db Commander; the original light palette remains available.

When updating, resolve the complete inheritance chain again and check both the rendered workbench and SQL tokens against the new source. Do not replace these values with approximate colors.
