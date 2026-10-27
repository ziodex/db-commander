import { contextBridge, ipcRenderer } from 'electron'
import type { DatabaseEvent, DesktopApi } from '../shared/contracts'
import type { SqlFileCommand } from '../shared/sql-files'
import { isLayoutCommand } from '../shared/layout-commands'
import { isUpdateStatus } from '../shared/updates'
import type { EditorSettings } from '../shared/editor-settings'

function updateStatus(value: unknown) {
  if (!isUpdateStatus(value)) throw new Error('Invalid update status.')
  return value
}

const api: DesktopApi = {
  preferences: () => ipcRenderer.invoke('sql:preferences'),
  savePreferences: settings => ipcRenderer.invoke('sql:savePreferences', settings),
  onPreferencesChanged: listener => {
    const callback = (_event: Electron.IpcRendererEvent, settings: EditorSettings) => listener(settings)
    ipcRenderer.on('sql:preferences-changed', callback)
    return () => ipcRenderer.removeListener('sql:preferences-changed', callback)
  },
  applicationMenu: () => ipcRenderer.invoke('sql:applicationMenu'),
  executeApplicationMenu: path => ipcRenderer.invoke('sql:executeApplicationMenu', path),
  updateTitleBar: appearance => ipcRenderer.invoke('sql:updateTitleBar', appearance),
  onAbout: listener => {
    const callback = (_event: Electron.IpcRendererEvent, version: unknown) => {
      if (typeof version === 'string' && version.length > 0 && version.length <= 96) listener(version)
    }
    ipcRenderer.on('sql:about', callback)
    return () => ipcRenderer.removeListener('sql:about', callback)
  },
  onApplicationMenuKey: listener => {
    const callback = (_event: Electron.IpcRendererEvent, index: unknown) => {
      if (index === null || (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 100)) listener(index)
    }
    ipcRenderer.on('sql:application-menu-key', callback)
    return () => ipcRenderer.removeListener('sql:application-menu-key', callback)
  },
  updateStatus: async () => updateStatus(await ipcRenderer.invoke('sql:updateStatus')),
  checkForUpdates: async () => updateStatus(await ipcRenderer.invoke('sql:checkForUpdates')),
  dismissUpdate: version => ipcRenderer.invoke('sql:dismissUpdate', version),
  openUpdatePage: () => ipcRenderer.invoke('sql:openUpdatePage'),
  onUpdateStatus: listener => {
    const callback = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isUpdateStatus(value)) listener(value)
    }
    ipcRenderer.on('sql:update-status', callback)
    return () => ipcRenderer.removeListener('sql:update-status', callback)
  },
  workspaceWindows: () => ipcRenderer.invoke('sql:workspaceWindows'),
  createWorkspaceWindow: name => ipcRenderer.invoke('sql:createWorkspaceWindow', name),
  openWorkspaceWindow: id => ipcRenderer.invoke('sql:openWorkspaceWindow', id),
  onWindowsCommand: listener => {
    const callback = () => listener()
    ipcRenderer.on('sql:windows-command', callback)
    return () => ipcRenderer.removeListener('sql:windows-command', callback)
  },
  prepareActivityAction: request => ipcRenderer.invoke('sql:prepareActivityAction',request),
  applyActivityAction: request => ipcRenderer.invoke('sql:applyActivityAction',request),
  inspectRollback: request => ipcRenderer.invoke('sql:inspectRollback',request),
  inspectActivity: request => ipcRenderer.invoke('sql:inspectActivity',request),
  saveActivity: snapshot => ipcRenderer.invoke('sql:saveActivity',snapshot),
  prepareQueryBuilder: request => ipcRenderer.invoke('sql:prepareQueryBuilder', request),
  prepareMigration: request => ipcRenderer.invoke('sql:prepareMigration', request),
  saveMigration: request => ipcRenderer.invoke('sql:saveMigration', request),
  explain: request => ipcRenderer.invoke('sql:explain', request),
  cancelExplain: id => ipcRenderer.invoke('sql:cancelExplain', id),
  savePlan: value => ipcRenderer.invoke('sql:savePlan', value),
  saveValue: value => ipcRenderer.invoke('sql:saveValue', value),

  prepareSchemaChange: request => ipcRenderer.invoke('sql:prepareSchemaChange', request),
  applySchemaChange: request => ipcRenderer.invoke('sql:applySchemaChange', request),
  cancelSchemaChange: id => ipcRenderer.invoke('sql:cancelSchemaChange', id),
  inspectImport: source => ipcRenderer.invoke('sql:inspectImport', source),
  startTransfer: request => ipcRenderer.invoke('sql:startTransfer', request),
  transferJobs: () => ipcRenderer.invoke('sql:transferJobs'),
  cancelTransfer: id => ipcRenderer.invoke('sql:cancelTransfer', id),
  chooseTransferFile: request => ipcRenderer.invoke('sql:chooseTransferFile', request),
  onTransferJob: listener => {
    const callback = (_event: Electron.IpcRendererEvent, job: import('../shared/transfer').TransferJob) => listener(job)
    ipcRenderer.on('sql:transfer-job', callback)
    return () => ipcRenderer.removeListener('sql:transfer-job', callback)
  },
  startBackup: request => ipcRenderer.invoke('sql:startBackup', request),
  backupJobs: () => ipcRenderer.invoke('sql:backupJobs'),
  retryBackupHistory: () => ipcRenderer.invoke('sql:retryBackupHistory'),
  cancelBackup: id => ipcRenderer.invoke('sql:cancelBackup', id),
  chooseBackupFile: request => ipcRenderer.invoke('sql:chooseBackupFile', request),
  onBackupJob: listener => {
    const callback = (_event: Electron.IpcRendererEvent, job: import('../shared/backup').BackupJob) => listener(job)
    ipcRenderer.on('sql:backup-job', callback)
    return () => ipcRenderer.removeListener('sql:backup-job', callback)
  },
  onLayoutCommand: listener => {
    const callback = (_event: Electron.IpcRendererEvent, command: unknown) => {
      if (isLayoutCommand(command)) listener(command)
    }
    ipcRenderer.on('sql:layout-command', callback)
    return () => ipcRenderer.removeListener('sql:layout-command', callback)
  },
  connect: config => ipcRenderer.invoke('sql:connect', config),
  connectSavedPassword: (profileId, config, sshSecrets) => ipcRenderer.invoke('sql:connectSavedPassword', { profileId, config, sshSecrets }),
  sessionSafety: id => ipcRenderer.invoke('sql:sessionSafety', id),
  unlockSession: (sessionId, confirmation) => ipcRenderer.invoke('sql:unlockSession', { sessionId, confirmation }),
  lockSession: id => ipcRenderer.invoke('sql:lockSession', id),
  chooseSshKey: () => ipcRenderer.invoke('sql:chooseSshKey'),
  cloneSession: id => ipcRenderer.invoke('sql:cloneSession', id),
  passwordStatus: profileId => ipcRenderer.invoke('sql:passwordStatus', profileId),
  saveProfilePassword: (profileId, password) => ipcRenderer.invoke('sql:saveProfilePassword', { profileId, password }),
  removeProfilePassword: profileId => ipcRenderer.invoke('sql:removeProfilePassword', profileId),
  disconnect: id => ipcRenderer.invoke('sql:disconnect', id),
  databases: id => ipcRenderer.invoke('sql:databases', id),
  switchDatabase: request => ipcRenderer.invoke('sql:switchDatabase', request),
  run: request => ipcRenderer.invoke('sql:run', request),
  cancel: id => ipcRenderer.invoke('sql:cancel', id),
  tables: id => ipcRenderer.invoke('sql:tables', id),
  editGrid: request => ipcRenderer.invoke('sql:editGrid', request),
  copyDefinition: sql => ipcRenderer.invoke('sql:copyDefinition', sql),
  compareData: request => ipcRenderer.invoke('sql:compareData', request),
  compareSchemas: request => ipcRenderer.invoke('sql:compareSchemas', request),
  diagram: request => ipcRenderer.invoke('sql:diagram',request),
  saveDiagram: request => ipcRenderer.invoke('sql:saveDiagram',request),
  inspectObject: request => ipcRenderer.invoke('sql:inspectObject', request),
  schema: id => ipcRenderer.invoke('sql:schema', id),
  loadWorkspace: () => ipcRenderer.invoke('sql:loadWorkspace'),
  saveWorkspace: workspace => ipcRenderer.invoke('sql:saveWorkspace', workspace),
  exportEditorSettings: settings => ipcRenderer.invoke('sql:exportEditorSettings', settings),
  importEditorSettings: () => ipcRenderer.invoke('sql:importEditorSettings'),
  searchHistory: search=>ipcRenderer.invoke('sql:searchHistory',search),
  historySettings: ()=>ipcRenderer.invoke('sql:historySettings'),
  saveHistorySettings: settings=>ipcRenderer.invoke('sql:saveHistorySettings',settings),
  favoriteHistory: (id,favorite)=>ipcRenderer.invoke('sql:favoriteHistory',{id,favorite}),
  deleteHistory: id=>ipcRenderer.invoke('sql:deleteHistory',id),
  snippets: search=>ipcRenderer.invoke('sql:snippets',search),
  saveSnippet: snippet=>ipcRenderer.invoke('sql:saveSnippet',snippet),
  deleteSnippet: id=>ipcRenderer.invoke('sql:deleteSnippet',id),
  exportSnippets: ids => ipcRenderer.invoke('sql:exportSnippets', ids),
  reviewSnippetImport: () => ipcRenderer.invoke('sql:reviewSnippetImport'),
  applySnippetImport: request => ipcRenderer.invoke('sql:applySnippetImport', request),
  discardSnippetImport: id => ipcRenderer.invoke('sql:discardSnippetImport', id),
  history: () => ipcRenderer.invoke('sql:history'),
  clearHistory: includeFavorites => ipcRenderer.invoke('sql:clearHistory',includeFavorites),
  exportCsv: (queryId, index) => ipcRenderer.invoke('sql:exportCsv', { queryId, index }),
  saveSql: sql => ipcRenderer.invoke('sql:saveSql', sql),
  saveSqlFile: request => ipcRenderer.invoke('sql:saveSqlFile', request),
  restoreSqlFiles: () => ipcRenderer.invoke('sql:restoreSqlFiles'),
  checkSqlFiles: () => ipcRenderer.invoke('sql:checkSqlFiles'),
  reloadSqlFile: request => ipcRenderer.invoke('sql:reloadSqlFile', request),
  finishSqlFileReload: request => ipcRenderer.invoke('sql:finishSqlFileReload', request),
  forgetSqlFile: id => ipcRenderer.invoke('sql:forgetSqlFile', id),
  clearRecentSqlFiles: () => ipcRenderer.invoke('sql:clearRecentSqlFiles'),
  onFileCommand: listener => {
    const callback = (_event: Electron.IpcRendererEvent, command: unknown) => { if (typeof command === 'string' && ['open', 'save', 'save-as', 'recent', 'reload'].includes(command)) listener(command as SqlFileCommand) }
    ipcRenderer.on('sql:file-command', callback)
    return () => ipcRenderer.removeListener('sql:file-command', callback)
  },
  chooseSqliteFile: create => ipcRenderer.invoke('sql:chooseSqliteFile', create),
  chooseDuckdbFile: create => ipcRenderer.invoke('sql:chooseDuckdbFile', create),
  openSql: request => ipcRenderer.invoke('sql:openSql', request),
  onSaveRequested: listener => {
    const callback = (_event: Electron.IpcRendererEvent, token: string) => {
      void listener().then(() => ipcRenderer.send('sql:workspace-flushed', token, true), () => ipcRenderer.send('sql:workspace-flushed', token, false))
    }
    ipcRenderer.on('sql:save-request', callback)
    return () => ipcRenderer.removeListener('sql:save-request', callback)
  },
  onEvent: listener => {
    const callback = (_event: Electron.IpcRendererEvent, event: DatabaseEvent, token?: string) => { try { listener(event) } finally { if (token) ipcRenderer.send('sql:ack', token) } }
    ipcRenderer.on('sql:event', callback)
    return () => ipcRenderer.removeListener('sql:event', callback)
  }
}
contextBridge.exposeInMainWorld('dbCommander', api)
