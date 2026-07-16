import { ipcMain } from 'electron'
import { createCommonJobConditionConfigWindow } from '../window/commonJobConditionConfigWindow'
import { mainWindow } from '../window/mainWindow'

export async function waitForCommonJobConditionDone() {
  return new Promise((resolve, reject) => {
    const window = createCommonJobConditionConfigWindow({
      parent: mainWindow!,
      modal: true,
      show: true
    })
    let processDone = false
    function handler() {
      processDone = true
      window.close()
    }
    ipcMain.once('common-job-condition-config-done', handler)
    window.on('closed', async () => {
      ipcMain.off('common-job-condition-config-done', handler)
      if (processDone) {
        resolve(true)
      } else {
        reject(new Error('USER_CANCELLED'))
      }
    })
  })
}
