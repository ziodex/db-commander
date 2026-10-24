import database from './assets/material-icons/database.svg'
import table from './assets/material-icons/table.svg'
import folder from './assets/material-icons/folder.svg'
import folderOpen from './assets/material-icons/folder-open.svg'
import folderDatabase from './assets/material-icons/folder-database.svg'
import folderDatabaseOpen from './assets/material-icons/folder-database-open.svg'
import folderFunctions from './assets/material-icons/folder-functions.svg'
import folderFunctionsOpen from './assets/material-icons/folder-functions-open.svg'
import folderViews from './assets/material-icons/folder-views.svg'
import folderViewsOpen from './assets/material-icons/folder-views-open.svg'
import key from './assets/material-icons/key.svg'
import trigger from './assets/material-icons/trigger.svg'
import consoleIcon from './assets/material-icons/console.svg'
import file from './assets/material-icons/file.svg'

const icons = { database, table, key, trigger, console: consoleIcon, file, view: folderViews }
export function MaterialIcon({ name, size = 16 }: { name: keyof typeof icons; size?: number }) {
  return <img className="material-icon" src={icons[name]} width={size} height={size} alt="" aria-hidden="true" draggable={false}/>
}

const folders = { schema: [folderDatabase, folderDatabaseOpen], functions: [folderFunctions, folderFunctionsOpen], views: [folderViews, folderViewsOpen], folder: [folder, folderOpen] }
export function MaterialFolderIcon({ kind = 'folder' }: { kind?: keyof typeof folders }) {
  return <span className="material-folder" aria-hidden="true"><img className="folder-closed" src={folders[kind][0]} alt="" draggable={false}/><img className="folder-open" src={folders[kind][1]} alt="" draggable={false}/></span>
}

export function CatalogObjectIcon({ kind }: { kind: string }) {
  const name = kind === 'table' ? 'table' : kind.includes('view') ? 'view' : kind === 'constraint' || kind === 'index' ? 'key' : kind === 'trigger' ? 'trigger' : ['function', 'procedure', 'macro'].includes(kind) ? 'console' : 'file'
  return <MaterialIcon name={name}/>
}
