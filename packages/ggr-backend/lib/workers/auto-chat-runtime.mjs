import DingtalkPlugin from '@geekgeekrun/dingtalk-plugin/index.mjs'
import { mainLoop } from '@geekgeekrun/geek-auto-start-chat-with-boss/index.mjs'
import { getPublicDbFilePath, readConfigFile, readStorageFile } from '@geekgeekrun/geek-auto-start-chat-with-boss/runtime-file-utils.mjs'
import SqlitePluginModule from '@geekgeekrun/sqlite-plugin'
import { sleep } from '@geekgeekrun/utils/sleep.mjs'
import { AsyncSeriesHook, SyncHook } from 'tapable'
import { resolveRerunInterval } from './restart-policy.mjs'
import { createWorkerControlClient } from './worker-control-client.mjs'

const { default: SqlitePlugin } = SqlitePluginModule
const KNOWN_FAILURES = ['LOGIN_STATUS_INVALID', 'ERR_INTERNET_DISCONNECTED', 'ACCESS_IS_DENIED']

function hooksForRuntime() {
  return {
    daemonInitialized: new AsyncSeriesHook(), puppeteerLaunched: new SyncHook(['browser']),
    pageGotten: new SyncHook(['page']), pageLoaded: new SyncHook(), cookieWillSet: new AsyncSeriesHook(['args']),
    userInfoResponse: new AsyncSeriesHook(['userInfo']), mainFlowWillLaunch: new AsyncSeriesHook(['args']),
    jobDetailIsGetFromRecommendList: new AsyncSeriesHook(['positionInfoDetail']),
    jobMarkedAsNotSuit: new AsyncSeriesHook(['positionInfoDetail', 'markDetail']),
    newChatWillStartup: new AsyncSeriesHook(['context']), newChatAttempted: new AsyncSeriesHook(['context']),
    newChatOutcome: new AsyncSeriesHook(['context', 'outcome']), newChatStartup: new AsyncSeriesHook(['positionInfoDetail', 'chatRunningContext']),
    noPositionFoundForCurrentJob: new SyncHook(), noPositionFoundAfterTraverseAllJob: new SyncHook(),
    errorEncounter: new SyncHook(['errorInfo']), encounterEmptyRecommendJobList: new AsyncSeriesHook(['args']),
    sageTimeEnter: new AsyncSeriesHook(['args']), sageTimeExit: new AsyncSeriesHook(['args'])
  }
}

function controlFailure(code, message) {
  return Object.assign(new Error(message), { code })
}

function policyStop(error, risk) {
  const reason = risk?.reason ?? (error instanceof Error ? error.message : String(error ?? 'auto-chat safety policy stopped'))
  return Object.assign(new Error(`auto-chat stopped by safety policy: ${reason}`), {
    code: 'SAFETY_POLICY_STOP',
    cause: error
  })
}

function valueAt(source, paths) {
  for (const path of paths) {
    let value = source
    for (const key of path) value = value?.[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function jobIdentity(job) {
  const jobId = valueAt(job, [['jobInfo', 'encryptId'], ['encryptId'], ['jobId']])
  const bossId = valueAt(job, [['jobInfo', 'encryptUserId'], ['bossInfo', 'encryptUserId'], ['encryptUserId'], ['bossId']])
  const companyId = valueAt(job, [['jobInfo', 'brandId'], ['brandInfo', 'encryptId'], ['brandInfo', 'brandId'], ['brandComInfo', 'encryptBrandId'], ['companyId']])
  const companyName = valueAt(job, [['brandName'], ['brandInfo', 'brandName'], ['brandComInfo', 'brandName'], ['brandComInfo', 'customerBrandName'], ['companyName']])
  if (jobId === undefined || bossId === undefined || (companyId === undefined && companyName === undefined)) {
    throw controlFailure('INVALID_AUTO_CHAT_CONTEXT', 'job does not contain a complete auto-chat identity')
  }
  return {
    jobId: String(jobId),
    bossId: String(bossId),
    ...(companyId === undefined ? { companyName: String(companyName) } : { companyId: String(companyId) })
  }
}

function chatContext(context = {}) {
  if (!context || typeof context !== 'object' || !context.sendControlPresent || typeof context.pageUrl !== 'string' || !context.pageUrl) {
    throw controlFailure('INVALID_AUTO_CHAT_CONTEXT', 'auto-chat requires page URL and send control context')
  }
  return { ...jobIdentity(context.job), pageUrl: context.pageUrl }
}

function keyFor(candidate) {
  return JSON.stringify(candidate)
}

export function applyAutoChatControlHooks({ hooks, controlClient } = {}) {
  if (!hooks || typeof hooks !== 'object') throw new TypeError('hooks are required')
  if (!controlClient || typeof controlClient.request !== 'function') throw new TypeError('controlClient.request is required')
  const consumed = new Map()
  hooks.jobDetailIsGetFromRecommendList.tapPromise('auto-chat-worker-control-browse', async (job) => {
    await controlClient.request('browse.record', { jobId: jobIdentity(job).jobId })
  })
  hooks.newChatWillStartup.tapPromise('auto-chat-worker-control-approval', async (context) => {
    const candidate = chatContext(context)
    const proposal = await controlClient.request('candidate.propose', candidate)
    if (typeof proposal?.grantForWorker !== 'string' || !proposal.grantForWorker) {
      throw controlFailure('INVALID_APPROVAL_GRANT', 'approval proposal did not include a worker grant')
    }
    await controlClient.request('grant.consume', { grant: proposal.grantForWorker, ...candidate })
    consumed.set(keyFor(candidate), candidate)
  })
  hooks.newChatOutcome.tapPromise('auto-chat-worker-control-outcome', async (context, outcome) => {
    const candidate = chatContext(context)
    const key = keyFor(candidate)
    if (!consumed.has(key)) throw controlFailure('CHAT_NOT_RESERVED', 'chat outcome has no consumed approval grant')
    await controlClient.request('chat.result', { ...candidate, outcome: String(outcome ?? 'unknown').toUpperCase() })
    consumed.delete(key)
  })
}

export function classifyAutoChatRisk(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const code = typeof error?.code === 'string' ? error.code : ''
  const signal = `${code} ${message}`.toUpperCase()
  if (signal.includes('LOGIN_STATUS_INVALID')) return { code: 'INVALID_LOGIN', reason: message }
  if (signal.includes('COOKIE_INVALID')) return { code: 'COOKIE_INVALID', reason: message }
  if (signal.includes('ACCESS_IS_DENIED')) return { statusCode: 403, code: 'ACCESS_IS_DENIED', reason: message }
  if (/zhipin\.com\/web\/common\/(?:403|error)\.html/i.test(message)) return { statusCode: 403, code: 'ACCESS_IS_DENIED', reason: message }
  if (/captcha|security(?:\s|_|-)?(?:check|challenge|verify)|验证/i.test(message)) return { code: 'SECURITY_CHALLENGE', reason: message }
  return null
}

async function reportAutoChatRisk({ error, controlClient }) {
  const risk = classifyAutoChatRisk(error)
  if (!risk) throw error
  try {
    await controlClient.request('risk.detected', risk)
  } catch (controlError) {
    throw policyStop(controlError, risk)
  }
  throw policyStop(error, risk)
}

export async function assertAutoChatStartupSafety({ cookies, controlClient } = {}) {
  if (cookies?.length) return
  await reportAutoChatRisk({
    error: controlFailure('COOKIE_INVALID', 'Boss cookies are required'),
    controlClient
  })
}

export async function runAutoChatMainLoop({ hooks, mainLoopImpl = mainLoop, controlClient } = {}) {
  try {
    return await mainLoopImpl(hooks)
  } catch (error) {
    if (error?.code === 'SAFETY_CHANNEL_UNAVAILABLE') throw policyStop(error)
    await reportAutoChatRisk({ error, controlClient })
  }
}

export async function createAutoChatRuntime({ rerunInterval = resolveRerunInterval(), controlClient = createWorkerControlClient() } = {}) {
  await assertAutoChatStartupSafety({ cookies: readStorageFile('boss-cookies.json'), controlClient })
  const hooks = hooksForRuntime()
  const dingTalkToken = readConfigFile('dingtalk.json').groupRobotAccessToken
  new DingtalkPlugin(dingTalkToken).apply(hooks)
  new SqlitePlugin(getPublicDbFilePath()).apply(hooks)
  applyAutoChatControlHooks({ hooks, controlClient })
  await hooks.daemonInitialized.callAsync(() => {})
  return {
    async runOnce({ taskReporter }) {
      try {
        await runAutoChatMainLoop({ hooks, controlClient })
      } catch (error) {
        const knownCode = KNOWN_FAILURES.find((code) => error instanceof Error && error.message.includes(code))
        const closeError = error && typeof error === 'object' ? error.closeError : null
        taskReporter.emit('task.progress', {
          workerId: 'geekAutoStartWithBossMain',
          state: 'runtime-error',
          code: knownCode ?? error?.code ?? 'AUTO_CHAT_FAILED',
          message: error instanceof Error ? error.message : String(error),
          ...(closeError ? {
            closeError: {
              code: typeof closeError.code === 'string' ? closeError.code : 'BROWSER_CLOSE_FAILED',
              message: closeError instanceof Error ? closeError.message : String(closeError)
            }
          } : {})
        })
        if (knownCode || error?.code === 'SAFETY_POLICY_STOP') throw Object.assign(error, { code: knownCode ?? error.code })
        taskReporter.emit('task.progress', { workerId: 'geekAutoStartWithBossMain', state: 'restarting', delayMs: rerunInterval })
        await sleep(rerunInterval)
      }
    }
  }
}
