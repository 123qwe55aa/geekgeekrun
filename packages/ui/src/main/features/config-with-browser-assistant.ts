import { ipcMain } from 'electron'
import {
  createBrowserAssistantWindow
} from '../window/browserAssistantWindow'

type BrowserAssistantOptions = {
  windowOption?: Electron.BrowserWindowConstructorOptions
  autoFind?: boolean
}

export async function configWithBrowserAssistant({ windowOption, autoFind }: BrowserAssistantOptions = {}) {
  return new Promise((resolve, reject) => {
    const window = createBrowserAssistantWindow({ ...windowOption }, { autoFind })

    let processDone = false
    function handler() {
      processDone = true
      window.close()
    }
    ipcMain.once('browser-config-saved', handler)
    window.once('closed', () => {
      ipcMain.off('browser-config-saved', handler)
      if (processDone) {
        resolve(true)
      } else {
        reject(new Error('USER_CANCELLED_CONFIG_BROWSER'))
      }
    })
  })
}
