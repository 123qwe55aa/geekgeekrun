import { ipcMain } from 'electron'
import {
  createBrowserDownloadProgressWindow
} from '../window/browserDownloadProgressWindow'

export async function openBrowserDownloadWindow({ windowOption }: { windowOption?: Electron.BrowserWindowConstructorOptions } = {}) {
  // The progress window delegates downloading to the backend-owned compatibility flow.
  return new Promise((resolve, reject) => {
    const window = createBrowserDownloadProgressWindow({ ...windowOption })

    let processDone = false
    let pathOfDownloadedBrowser: string | null = null
    function handler(_event: Electron.IpcMainEvent, executablePath: string) {
      pathOfDownloadedBrowser = executablePath
      processDone = true
      window.close()
    }
    ipcMain.once('browser-download-done', handler)
    window.once('closed', () => {
      ipcMain.off('browser-download-done', handler)
      if (processDone) {
        resolve(pathOfDownloadedBrowser)
      } else {
        reject(new Error('USER_CANCELLED_CONFIG_BROWSER'))
      }
    })
  })
}
