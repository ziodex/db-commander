import type { editor } from 'monaco-editor'
import theme from './vscode-dark-2026.json'

// Keep the workbench and Monaco on the same upstream palette. Theme inheritance
// is flattened in the vendored JSON; later TextMate rules take precedence.
export const vscodeDarkColors = theme.colors
function tokenColor(scope: string): string {
  let foreground = theme.colors['editor.foreground'], specificity = -1
  for (const rule of theme.tokenColors) {
    for (const selector of Array.isArray(rule.scope) ? rule.scope : [rule.scope]) {
      // A more specific inherited scope wins over a later generic rule, just
      // as in VS Code (e.g. support.function over support). Contextual selectors
      // do not match these standalone SQL scopes.
      if (typeof selector === 'string' && !selector.includes(' ') && (scope === selector || scope.startsWith(`${selector}.`)) && selector.length >= specificity && rule.settings.foreground) {
        foreground = rule.settings.foreground; specificity = selector.length
      }
    }
  }
  return foreground.replace('#', '')
}

export const vscodeDarkEditorTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark', inherit: false,
  colors: theme.colors,
  // Monaco's SQL tokenizer uses Monarch names rather than TextMate scopes.
  // Resolve their corresponding scopes from the original 2026 Dark rules.
  rules: [
    { token: '', foreground: theme.colors['editor.foreground'].slice(1) },
    { token: 'comment', foreground: tokenColor('comment.line.double-dash.sql'), fontStyle: '' },
    { token: 'keyword', foreground: tokenColor('keyword.other.DML.sql') },
    { token: 'operator', foreground: tokenColor('keyword.operator.sql') },
    { token: 'operator.word', foreground: tokenColor('keyword.other.DML.sql') },
    { token: 'string', foreground: tokenColor('string.quoted.single.sql') },
    { token: 'number', foreground: tokenColor('constant.numeric.sql') },
    { token: 'predefined', foreground: tokenColor('support.function.sql') },
    { token: 'type', foreground: tokenColor('storage.type.sql') },
    { token: 'variable', foreground: tokenColor('variable.other.sql') },
    { token: 'identifier', foreground: theme.colors['editor.foreground'].slice(1) },
    { token: 'delimiter', foreground: theme.colors['editor.foreground'].slice(1) }
  ]
}

export function installVSCodeThemeColors(root: HTMLElement): void {
  for (const [name, color] of Object.entries(theme.colors)) root.style.setProperty(`--vscode-${name.replaceAll('.', '-')}`, color)
}
