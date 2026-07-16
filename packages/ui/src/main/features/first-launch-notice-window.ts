import fs from 'fs'
import os from 'os'
import path from 'path'
import buildInfo from '../../common/build-info.json'
import {
  createFirstLaunchNoticeWindow
} from '../window/firstLaunchNoticeWindow'
import { ipcMain } from 'electron'

export const firstLaunchNoticeApproveFlagPath = path.join(
  os.homedir(),
  '.geekgeekrun/storage',
  'ui-first-launch-notice-flag'
)

export const isFirstLaunchNoticeApproveFlagExist = () =>
  fs.existsSync(firstLaunchNoticeApproveFlagPath)
export const createFirstLaunchNoticeApproveFlag = () => {
  fs.mkdirSync(path.dirname(firstLaunchNoticeApproveFlagPath), { recursive: true })
  fs.writeFileSync(firstLaunchNoticeApproveFlagPath, buildInfo.version)
}
export async function waitForUserApproveAgreement({ windowOption }: { windowOption?: Electron.BrowserWindowConstructorOptions } = {}) {
  return new Promise((resolve, reject) => {
    const window = createFirstLaunchNoticeWindow({ ...windowOption })
    let processDone = false
    function handler() {
      processDone = true
      window.close()
    }
    ipcMain.once('first-launch-notice-approve', handler)
    window.once('closed', () => {
      ipcMain.off('first-launch-notice-approve', handler)
      if (processDone) {
        resolve(true)
      } else {
        reject(new Error('USER_CANCELLED'))
      }
    })
  })
}
