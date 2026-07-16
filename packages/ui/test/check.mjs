import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

async function read(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), 'utf8')
}

const uiPackage = JSON.parse(await read('packages/ui/package.json'))
assert.ok(uiPackage.dependencies.dayjs, 'main-process dayjs must be declared as a production dependency for packaged Electron')

const electronViteConfigSource = await read('packages/ui/electron.vite.config.ts')
assert.doesNotMatch(electronViteConfigSource, /externalizeMainBareImportsPlugin/, 'main build must not externalize every bare import, or transitive runtime modules can be omitted from packaged Electron')
assert.match(electronViteConfigSource, /externalizeDepsPlugin\(\)/, 'main build must retain normal production-dependency externalization')

const backendBootstrapSource = await read('packages/ui/src/main/backend/bootstrap.ts')
assert.match(backendBootstrapSource, /const BOOTSTRAP_VERSION = '1\.0\.1'/, 'Electron must install a new supervisor bootstrap version when its runtime dependency closure changes')

const traySource = await read('packages/ui/src/main/features/tray.ts')
assert.match(traySource, /import\s+\{[^}]*Tray[^}]*\}\s+from ['"]electron['"]/, 'tray feature must import Electron Tray')
assert.match(traySource, /new\s+Tray\(/, 'tray feature must create a Tray instance')
assert.match(traySource, /setContextMenu\(/, 'tray feature must expose a context menu')
assert.match(traySource, /requestBackend/, 'tray must call the backend client')
assert.match(traySource, /task\.stop/, 'tray must stop auto chat through the backend protocol')
assert.match(traySource, /task\.list/, 'tray must read status through the backend protocol')
assert.match(traySource, /approval\.list/, 'tray must read pending approval replies')
assert.match(traySource, /approval\.approve/, 'tray must approve AI auto replies through the backend protocol')
assert.match(traySource, /approval\.requireHuman/, 'tray must mark queued replies through the backend protocol')
assert.match(traySource, /AI 自动回复审批/, 'tray must expose an AI auto-reply approval queue entry')
assert.match(traySource, /backendEvents\.on\(['"]event['"]/, 'tray must subscribe to backend events')
assert.match(traySource, /event\.event\s*===\s*['"]system\.status['"]/, 'tray must update from backend status broadcasts')
assert.match(traySource, /approval\.required/, 'tray must refresh approval state from approval-required events')
assert.match(traySource, /task\.exited/, 'tray must react to worker exit events')
assert.match(traySource, /enabled:\s*!isBossRunning/, 'tray start action must reflect running state')
assert.match(traySource, /enabled:\s*isBossRunning\s*&&\s*!isBossStopping/, 'tray stop action must reflect running state')
assert.match(traySource, /process\.env\.GGR_HEADLESS/, 'tray must control headless mode through GGR_HEADLESS')
assert.match(traySource, /label:\s*['"]开始自动开聊['"]/, 'tray must show start auto chat action')
assert.match(traySource, /停止自动开聊/, 'tray must show stop auto chat action')
assert.match(traySource, /查看运行状态/, 'tray must show status action')
assert.match(traySource, /label:\s*['"]Headless 模式['"]/, 'tray must show headless toggle')
assert.match(traySource, /syncBossWorkerStateFromDaemon\(\)/, 'tray must load initial worker state from daemon')

const openSettingWindowSource = await read('packages/ui/src/main/flow/OPEN_SETTING_WINDOW/index.ts')
assert.match(openSettingWindowSource, /initTray\(/, 'setting window flow must initialize the tray')

const settingIpcSource = await read('packages/ui/src/main/flow/OPEN_SETTING_WINDOW/ipc/index.ts')
assert.match(settingIpcSource, /workerExitHandlerByMode/, 'worker exit forwarding must keep only one listener per worker')
assert.match(settingIpcSource, /WORKER_STOP_TIMEOUT_MS/, 'stopping a worker must have a bounded wait')
assert.match(settingIpcSource, /requestBackend(?:<[^>]+>)?\('browser\.openBoss'/, 'Boss UI must call the backend browser protocol')
assert.doesNotMatch(settingIpcSource, /PUPPETEER_EXECUTABLE_PATH|--mode=launchBossSite|childProcess\.spawn|createBrowserCompatibilityApi/, 'Boss UI must not inject an executable or self-spawn a browser child')
for (const channel of ['get-agent-safety-status', 'list-auto-chat-approvals', 'approve-auto-chat-approval', 'reject-auto-chat-approval', 'resume-agent-safety']) {
  assert.match(settingIpcSource, new RegExp(`ipcMain\\.handle\\(['\"]${channel}['\"]`), `Electron must expose ${channel} through its main-process IPC facade`)
}
for (const method of ['agent.status', 'safety.status', 'approval.list', 'approval.approve', 'approval.reject', 'safety.resume']) {
  assert.match(settingIpcSource, new RegExp(`requestBackend[\\s\\S]{0,80}['\"]${method.replace('.', '\\.')}['\"]`), `safety IPC facade must delegate ${method} to the backend protocol`)
}
assert.match(settingIpcSource, /mainWindow\?\.webContents\.send\('agent-safety-updated'/, 'main process must relay authoritative safety events to the renderer')

const autoChatRunningStatusSource = await read('packages/ui/src/renderer/src/page/GeekAutoStartChatWithBoss/RunningStatus.vue')
assert.match(autoChatRunningStatusSource, /PAUSED_RISK/, 'auto-chat running page must render the risk-paused state')
assert.match(autoChatRunningStatusSource, /policyStatus\.reason/, 'auto-chat running page must render the authoritative safety reason')
assert.match(autoChatRunningStatusSource, /quota/, 'auto-chat running page must render backend-reported quota use')
assert.match(autoChatRunningStatusSource, /pendingApprovals/, 'auto-chat running page must render pending approval controls')
assert.match(autoChatRunningStatusSource, /approve-auto-chat-approval/, 'approval controls must use the Electron IPC facade')
assert.match(autoChatRunningStatusSource, /reject-auto-chat-approval/, 'approval controls must use the Electron IPC facade')
assert.match(autoChatRunningStatusSource, /resume-agent-safety/, 'risk recovery must be an explicit backend resume operation')
assert.match(autoChatRunningStatusSource, /startDisabled[\s\S]{0,240}PAUSED_RISK/, 'start must be disabled for risk pauses')
assert.match(autoChatRunningStatusSource, /startDisabled[\s\S]{0,240}PAUSED_QUOTA/, 'start must be disabled for quota pauses')
assert.match(autoChatRunningStatusSource, /agent-safety-updated/, 'running page must subscribe to the main-process backend event relay')
assert.match(autoChatRunningStatusSource, /quota\.browsePerDay/, 'running page must render the authoritative daily browse quota')
assert.doesNotMatch(autoChatRunningStatusSource, /PAUSED_QUOTA[\s\S]{0,400}resume-agent-safety/, 'quota pauses must not offer the risk-resume operation')

const autoChatConfigSource = await read('packages/ui/src/renderer/src/page/MainLayout/GeekAutoStartChatWithBoss/index.vue')
assert.match(autoChatConfigSource, /get-agent-safety-status/, 'the live auto-chat start form must fetch backend safety state')
assert.match(autoChatConfigSource, /autoChatPaused/, 'the live auto-chat start form must derive its start state from the policy')
assert.match(autoChatConfigSource, /PAUSED_RISK/, 'the live auto-chat start form must recognize risk pauses')
assert.match(autoChatConfigSource, /PAUSED_QUOTA/, 'the live auto-chat start form must recognize quota pauses')
assert.match(autoChatConfigSource, /v-if="!autoChatPaused"[\s\S]{0,200}handleSubmit/, 'the live auto-chat start action must not be offered while paused')
assert.match(autoChatConfigSource, /handleSafetyResume[\s\S]{0,180}PAUSED_RISK/, 'only a risk pause may invoke the explicit safety resume operation')
assert.match(autoChatConfigSource, /policyStatus\.value\.status !== 'PAUSED_RISK'/, 'the explicit resume handler must reject non-risk states')
assert.match(autoChatConfigSource, /agent-safety-updated/, 'the live auto-chat start form must refresh from the main-process relay')

const cookieAssistantSource = await read('packages/ui/src/main/window/cookieAssistantWindow.ts')
assert.match(cookieAssistantSource, /requestBackend<\{ taskId: string \}>\('browser\.openLogin'\)/, 'cookie UI must call the backend browser protocol')
assert.match(cookieAssistantSource, /save-boss-session/, 'cookie UI main process must expose a backend-owned session save IPC')
assert.match(cookieAssistantSource, /writeBackendConfig\('boss_cookies', cookies\)/, 'cookie UI main process must persist manual cookies through the backend session API')
assert.doesNotMatch(cookieAssistantSource, /PUPPETEER_EXECUTABLE_PATH|--mode=launchBossZhipinLoginPageWithPreloadExtension|childProcess\.spawn|createBrowserCompatibilityApi/, 'cookie UI must not inject an executable or self-spawn a browser child')

const cookieAssistantRendererSource = await read('packages/ui/src/renderer/src/page/CookieAssistant/index.vue')
assert.match(cookieAssistantRendererSource, /invoke\('save-boss-session'/, 'manual Cookie Assistant saves must use the main-process session IPC')
assert.doesNotMatch(cookieAssistantRendererSource, /write-storage-file[\s\S]{0,150}boss-cookies\.json/, 'manual Cookie Assistant saves must not write only the legacy cookie mirror')

const cookieInvalidationSource = await read('packages/ui/src/main/features/cookie-invalid-handle-plugin.ts')
assert.match(cookieInvalidationSource, /requestBackend\('config\.write'/, 'cookie invalidation must use the backend protocol')
assert.doesNotMatch(cookieInvalidationSource, /readStorageFile|writeStorageFile/, 'cookie invalidation must not access browser storage directly')

const autoChatSource = await read('packages/geek-auto-start-chat-with-boss/index.mjs')
assert.doesNotMatch(
  autoChatSource,
  /const allowedAreas\s*=\s*\[['"]南山['"]/,
  'auto chat must not apply a hard-coded district allowlist'
)
assert.doesNotMatch(
  autoChatSource,
  /const CUSTOM_OPENING\s*=\s*customOpeningMessage\s*\|\|/,
  'auto chat must not invent an opening message when the user configured none'
)
assert.doesNotMatch(
  autoChatSource,
  /SOC monitoring experience and built AI agent tools/,
  'auto chat must not send a developer-specific fallback opening message'
)

const mainWindowSource = await read('packages/ui/src/main/window/mainWindow.ts')
assert.match(mainWindowSource, /function\s+showMainWindow\(/, 'main window module must expose showMainWindow for tray actions')
assert.match(mainWindowSource, /function\s+hideMainWindow\(/, 'main window module must expose hideMainWindow for tray actions')

const headlessLoggerSource = await read('packages/ui/src/main/features/headless-terminal-logger.ts')
assert.match(headlessLoggerSource, /function\s+redactTerminalText/, 'headless terminal logger must redact sensitive text')
assert.match(headlessLoggerSource, /\[手机号\]/, 'headless terminal logger must redact phone numbers')
assert.match(headlessLoggerSource, /\[邮箱\]/, 'headless terminal logger must redact emails')
assert.match(headlessLoggerSource, /redactTerminalText\(JSON\.stringify\(msgData\)\)/, 'fallback terminal logs must be redacted')
assert.match(headlessLoggerSource, /message\.code/, 'headless terminal logger must print daemon worker exit code')
assert.doesNotMatch(headlessLoggerSource, /message\.exitCode/, 'daemon worker exit payload uses code, not exitCode')
assert.doesNotMatch(headlessLoggerSource, /\$\{imgUrl\}/, 'headless terminal logger must not print raw image URLs')

console.log('ui static check passed')
