import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'
import './themes/vscode-dark-2026.css'
import { installVSCodeThemeColors } from './themes/vscode-dark-2026'
installVSCodeThemeColors(document.documentElement)
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
