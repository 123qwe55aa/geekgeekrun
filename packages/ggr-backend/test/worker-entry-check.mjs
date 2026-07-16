import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncSeriesHook } from 'tapable'

import { runAutoChat } from '../lib/workers/auto-chat.mjs'
import { runReadNoReply } from '../lib/workers/read-no-reply.mjs'
import { createWorkerReporter } from '../lib/workers/worker-reporter.mjs'
import { resolveRerunInterval } from '../lib/workers/restart-policy.mjs'
import { applyAutoChatControlHooks, runAutoChatMainLoop } from '../lib/workers/auto-chat-runtime.mjs'

async function checkWorker(run, workerId) {
  const events = []
  let runs = 0
  await run({
    runtime: { async runOnce() { runs++ } },
    taskReporter: { emit: (event, data) => events.push({ event, data }) },
    shouldStop: async () => runs === 1
  })
  assert.equal(runs, 1)
  assert(events.some(({ event, data }) => event === 'task.progress' && data.workerId === workerId && data.state === 'completed'))

  const failureEvents = []
  await assert.rejects(run({
    runtime: { async runOnce() { throw Object.assign(new Error('login expired'), { code: 'LOGIN_STATUS_INVALID' }) } },
    taskReporter: { emit: (event, data) => failureEvents.push({ event, data }) },
    shouldStop: async () => false
  }), { code: 'LOGIN_STATUS_INVALID' })
  assert(failureEvents.some(({ event, data }) => event === 'task.progress' && data.state === 'failed' && data.code === 'LOGIN_STATUS_INVALID'))
}

await checkWorker(runAutoChat, 'geekAutoStartWithBossMain')
await checkWorker(runReadNoReply, 'readNoReplyAutoReminderMain')

{
  const lines = []
  const reporter = createWorkerReporter({ write: (line) => lines.push(line) })
  reporter.emit('task.progress', { workerId: 'geekAutoStartWithBossMain', state: 'running' })
  assert.deepEqual(JSON.parse(lines[0]), {
    ggrWorkerEvent: 1,
    event: 'task.progress',
    data: { workerId: 'geekAutoStartWithBossMain', state: 'running' }
  })
  assert(lines[0].endsWith('\n'))
  assert.throws(() => reporter.emit('task.exited', { workerId: 'geekAutoStartWithBossMain' }), { code: 'INVALID_WORKER_EVENT' })
  assert.throws(() => reporter.emit('task.progress', []), { code: 'INVALID_WORKER_EVENT' })
}

assert.equal(resolveRerunInterval({ MAIN_BOSSGEEKGO_RERUN_INTERVAL: '0' }), 0)
assert.equal(resolveRerunInterval({ MAIN_BOSSGEEKGO_RERUN_INTERVAL: 'not-a-number' }), 5000)

{
  const calls = []
  const hooks = {
    jobDetailIsGetFromRecommendList: new AsyncSeriesHook(['job']),
    newChatWillStartup: new AsyncSeriesHook(['context']),
    newChatOutcome: new AsyncSeriesHook(['context', 'outcome'])
  }
  applyAutoChatControlHooks({
    hooks,
    controlClient: {
      request: async (type, data) => {
        calls.push({ type, data })
        return type === 'candidate.propose' ? { grantForWorker: 'grant-1' } : { id: `${type}-1` }
      }
    }
  })
  const job = { jobInfo: { encryptId: 'job-1', encryptUserId: 'boss-1', brandId: 'company-1' }, brandName: 'Acme' }
  await hooks.jobDetailIsGetFromRecommendList.promise(job)
  await hooks.newChatWillStartup.promise({ pageUrl: 'https://www.zhipin.com/web/geek/jobs', job, sendControlPresent: true })
  await hooks.newChatOutcome.promise({ pageUrl: 'https://www.zhipin.com/web/geek/jobs', job, sendControlPresent: true }, 'sent')
  assert.deepEqual(calls.map(({ type }) => type), ['browse.record', 'candidate.propose', 'grant.consume', 'chat.result'])
  assert.deepEqual(calls[1].data, { jobId: 'job-1', bossId: 'boss-1', companyId: 'company-1', pageUrl: 'https://www.zhipin.com/web/geek/jobs' })
  assert.deepEqual(calls[2].data, { grant: 'grant-1', jobId: 'job-1', bossId: 'boss-1', companyId: 'company-1', pageUrl: 'https://www.zhipin.com/web/geek/jobs' })
  assert.deepEqual(calls[3].data, { jobId: 'job-1', bossId: 'boss-1', companyId: 'company-1', pageUrl: 'https://www.zhipin.com/web/geek/jobs', outcome: 'SENT' })
}

{
  const calls = []
  await assert.rejects(runAutoChatMainLoop({
    hooks: {},
    mainLoopImpl: async () => { throw new Error('ACCESS_IS_DENIED at https://www.zhipin.com/web/common/403.html') },
    controlClient: { request: async (type, data) => { calls.push({ type, data }) } }
  }), { code: 'SAFETY_POLICY_STOP' })
  assert.deepEqual(calls, [{ type: 'risk.detected', data: { statusCode: 403, code: 'ACCESS_IS_DENIED', reason: 'ACCESS_IS_DENIED at https://www.zhipin.com/web/common/403.html' } }])
}

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const relative of ['lib/workers/auto-chat.mjs', 'lib/workers/read-no-reply.mjs']) {
  const source = await fs.readFile(path.join(backendRoot, relative), 'utf8')
  assert(!source.match(/from\s+['"]electron['"]/))
  assert(!source.includes('minimist'))
  assert(!source.includes('--mode'))
  assert(!source.match(/process\.exit\s*\(/))
}

const serverSource = await fs.readFile(path.join(backendRoot, 'server.mjs'), 'utf8')
assert(serverSource.includes('geekAutoStartWithBossMain'))
assert(serverSource.includes('readNoReplyAutoReminderMain'))
assert(!serverSource.includes('services.workerEntries ?? {}'))

const runtimeSource = await fs.readFile(path.join(backendRoot, 'lib/workers/auto-chat-runtime.mjs'), 'utf8')
assert(runtimeSource.includes("state: 'runtime-error'"))
assert(runtimeSource.includes('closeError'))
assert(!runtimeSource.match(/closeBrowserWindow\?\.\s*\(/), 'mainLoop must be the only browser cleanup owner')
const autoChatSource = await fs.readFile(path.join(backendRoot, 'lib/workers/auto-chat.mjs'), 'utf8')
assert(autoChatSource.includes('createWorkerControlClient()'))

console.log('ggr backend worker entry check passed')
