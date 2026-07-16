import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { openDevTools } from '../../commands'

const isMac = process.platform === 'darwin'

const macEditSubmenu: MenuItemConstructorOptions[] = [
  { role: 'pasteAndMatchStyle' },
  { role: 'delete' },
  { role: 'selectAll' },
  { type: 'separator' },
  { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
]
const otherEditSubmenu: MenuItemConstructorOptions[] = [
  { role: 'delete' },
  { type: 'separator' },
  { role: 'selectAll' }
]
const editSubmenu: MenuItemConstructorOptions[] = [
  { role: 'undo' },
  { role: 'redo' },
  { type: 'separator' },
  { role: 'cut' },
  { role: 'copy' },
  { role: 'paste' },
  ...(isMac ? macEditSubmenu : otherEditSubmenu),
  { type: 'separator' }
]
const macApplicationMenu: MenuItemConstructorOptions = {
  label: app.name,
  submenu: [
    { role: 'about' },
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' }
  ]
}
const helpSubmenu: MenuItemConstructorOptions[] = [{
  label: '为当前窗口打开调试工具',
  accelerator: 'CommandOrControl+Shift+I',
  click(_menuItem, window) {
    if (window instanceof BrowserWindow) openDevTools(window)
  }
}]

const template: MenuItemConstructorOptions[] = [
  ...(isMac ? [macApplicationMenu] : []),
  { label: 'Edit', submenu: editSubmenu },
  { role: 'help', submenu: helpSubmenu }
]

const menu = Menu.buildFromTemplate(template)
Menu.setApplicationMenu(menu)
