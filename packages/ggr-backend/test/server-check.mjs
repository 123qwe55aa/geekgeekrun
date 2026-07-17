import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { createGgrClient } from '@geekgeekrun/ggr-client'
import { initDb } from '@geekgeekrun/sqlite-plugin'
import { createBackendServer } from '../server.mjs'
import { createRuntimePaths } from '../lib/runtime-paths.mjs'
import { createConfigService } from '../lib/services/config-service.mjs'
import { createLogger } from '../lib/logger.mjs'
import { createRouter, registerServiceHandlers } from '../lib/router.mjs'

async function rawSession(socketPath, requests) {
  const socket = net.createConnection(socketPath)
  return new Promise((resolve, reject) => {
    let buffer = ''
    const replies = []
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        replies.push(JSON.parse(line))
        if (replies.length === requests.length) {
          socket.end()
          resolve(replies)
        }
      }
    })
    socket.on('connect', () => {
      for (const request of requests) socket.write(`${JSON.stringify(request)}\n`)
    })
  })
}

{
  const filters = []
  const router = createRouter()
  registerServiceHandlers(router, {
    methods: { APPROVAL_LIST: 'approval.list' },
    task: {},
    approval: { list: async () => [] },
    policy: {},
    listSafetyApprovals: async (value) => { filters.push(value); return [] }
  })

  await router.dispatch({ method: 'approval.list', params: { kind: 'AUTO_CHAT' } })
  await router.dispatch({ method: 'approval.list', params: { kind: 'AUTO_CHAT', status: 'REJECTED' } })
  await router.dispatch({ method: 'approval.list', params: { includeAll: true, kind: 'AUTO_CHAT' } })
  assert.deepEqual(filters, [
    { kind: 'AUTO_CHAT', status: 'PENDING' },
    { kind: 'AUTO_CHAT', status: 'REJECTED' },
    { kind: 'AUTO_CHAT' }
  ], 'filtered approval listing must preserve the pending default unless all statuses are requested')
}

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-backend-'))
const runtimePaths = createRuntimePaths(tempHome)
await fs.mkdir(runtimePaths.storageDir, { recursive: true })
await fs.writeFile(path.join(runtimePaths.storageDir, 'hr-reply-approval-queue.json'), JSON.stringify([
  { id: 'approval-one', status: 'pending' },
  { id: 'approval-two', status: 'pending' }
]))
const taskChildren = []
const cancelledBrowserTasks = []
const openedBossUrls = []
const savedExecutables = []
const backend = await createBackendServer({
  socketPath: runtimePaths.backendSocket,
  version: '0.1.0',
  runtimePaths,
  services: {
    workerEntries: { auto: '/tmp/auto.mjs' },
    spawnProcess: () => {
      const child = new EventEmitter()
      child.pid = 700 + taskChildren.length
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = (signal) => { queueMicrotask(() => child.emit('exit', null, signal)); return true }
      taskChildren.push(child)
      return child
    },
    stopTimeoutMs: 10,
    browser: {
      async openBoss({ url }) { openedBossUrls.push(url); return { taskId: 'boss-task', state: 'starting' } },
      async prepare() { return { taskId: 'prepare-task', state: 'starting' } },
      async getAvailable(options) { return { browser: 'test', executablePath: '/tmp/test-browser', options } },
      async setExecutable(value) { savedExecutables.push(value); return { browser: value.browser, executablePath: value.executablePath } },
      async cancel(taskId) { cancelledBrowserTasks.push(taskId); return { taskId, state: 'cancelled' } },
      async close() {}
    },
    llm: {
      async request(messageList, options) { return { responseText: 'test reply', messageList, options } }
    }
  }
})

try {
  await backend.start()
  const client = createGgrClient({
    socketPath: runtimePaths.backendSocket,
    client: 'test',
    clientVersion: '1.0.0'
  })
  await client.connect()
  const events = []
  client.onEvent((event) => events.push(event))

  assert.deepEqual(await client.request('system.health'), {
    ready: true,
    version: '0.1.0',
    protocolVersion: 1
  })
  await client.request('config.write', {
    resource: 'opening_message',
    patch: { openingMessage: 'hello', nested: { password: 'hidden', safe: 'shown' } }
  })
  const config = await client.request('config.read', { resource: 'opening_message' })
  assert.equal(config.data.openingMessage, 'hello')
  assert.equal(config.data.nested.password, '[redacted]')
  assert.equal(config.data.nested.safe, 'shown')
  assert.equal((await fs.stat(path.join(runtimePaths.configDir, 'boss.json'))).mode & 0o777, 0o600)

  await client.request('config.write', {
    resource: 'resumes',
    patch: [{ name: '默认简历', content: { name: 'Test User' } }]
  })
  assert.equal((await client.request('config.read', { resource: 'resumes' })).data[0].name, '默认简历')
  await client.request('config.write', { resource: 'boss_cookies', patch: [{ name: 'session', value: 'secret' }] })
  assert.deepEqual((await client.request('config.read', { resource: 'boss_cookies' })).data, {
    configured: true,
    cookieCount: 1
  })
  await client.request('config.write', {
    resource: 'llm_config',
    patch: [{ id: 'primary', providerApiSecret: 'keep-this-secret', providerCompleteApiUrl: 'https://llm.test' }]
  })
  const redactedLlmConfig = await client.request('config.read', { resource: 'llm_config' })
  assert.equal(redactedLlmConfig.data[0].providerApiSecret, '[redacted]')
  assert.deepEqual(await client.request('llm.test', { messageList: [{ text: 'hello' }], llmConfigIdForPick: ['primary'] }), {
    responseText: 'test reply', messageList: [{ text: 'hello' }], options: { llmConfigIdForPick: ['primary'] }
  })
  await client.request('config.write', { resource: 'llm_config', patch: redactedLlmConfig.data })
  assert.equal(
    JSON.parse(await fs.readFile(path.join(runtimePaths.configDir, 'llm.json'), 'utf8'))[0].providerApiSecret,
    'keep-this-secret'
  )
  await client.request('config.write', {
    resource: 'llm_config',
    patch: [{ ...redactedLlmConfig.data[0], providerApiSecret: 'replacement-secret' }]
  })
  assert.equal(
    JSON.parse(await fs.readFile(path.join(runtimePaths.configDir, 'llm.json'), 'utf8'))[0].providerApiSecret,
    'replacement-secret'
  )
  const prompt = await client.request('config.read', { resource: 'auto_reminder_rechat_template' })
  assert.match(prompt.data, /__REPLACE_REAL_RESUME_HERE__/)
  const defaultPrompt = await client.request('config.read', { resource: 'auto_reminder_open_template_default' })
  assert.equal(defaultPrompt.writable, false)
  assert.match(defaultPrompt.data, /开场白/)
  for (const [resource, property] of [
    ['job_filter_conditions', 'salaryList'],
    ['industry_filter_exemptions', 'length'],
    ['city_groups', 'zpData']
  ]) {
    const response = await client.request('config.read', { resource })
    assert.equal(response.writable, false)
    assert.ok(response.data[property] !== undefined)
    await assert.rejects(client.request('config.write', { resource, patch: {} }), { code: 'INVALID_PARAMS' })
  }
  const filterConditions = await client.request('config.read', { resource: 'job_filter_conditions' })
  assert.deepEqual(Object.keys(filterConditions.data).sort(), ['degreeList', 'experienceList', 'salaryList', 'scaleList'])
  for (const list of Object.values(filterConditions.data)) {
    for (const option of list) assert.deepEqual(Object.keys(option).sort(), ['code', 'name'])
  }
  const industryExemptions = await client.request('config.read', { resource: 'industry_filter_exemptions' })
  for (const group of industryExemptions.data) {
    assert.deepEqual(Object.keys(group).sort(), ['code', 'name', 'subLevelModelList'])
    for (const option of group.subLevelModelList) assert.deepEqual(Object.keys(option).sort(), ['code', 'name'])
  }
  const cityGroups = await client.request('config.read', { resource: 'city_groups' })
  assert.deepEqual(Object.keys(cityGroups.data), ['zpData'])
  assert.deepEqual(Object.keys(cityGroups.data.zpData).sort(), ['cityGroup', 'hotCityList'])
  for (const city of cityGroups.data.zpData.hotCityList) assert.deepEqual(Object.keys(city).sort(), ['code', 'name'])
  for (const group of cityGroups.data.zpData.cityGroup) {
    assert.deepEqual(Object.keys(group).sort(), ['cityList', 'firstChar'])
    for (const city of group.cityList) assert.deepEqual(Object.keys(city).sort(), ['code', 'name'])
  }

  for (const resource of ['../boss.json', 'boss.json', '/tmp/boss.json']) {
    await assert.rejects(client.request('config.read', { resource }), { code: 'INVALID_PARAMS' })
  }
  await assert.rejects(
    client.request('config.write', { resource: 'runtime_status', patch: {} }),
    { code: 'INVALID_PARAMS' }
  )

  assert.deepEqual(await client.request('task.list'), [])
  assert.deepEqual(await client.request('browser.openBoss', { url: 'https://www.zhipin.com/job_detail/job-1.html' }), { taskId: 'boss-task', state: 'starting' })
  assert.deepEqual(openedBossUrls, ['https://www.zhipin.com/job_detail/job-1.html'])
  await assert.rejects(client.request('browser.openBoss', { url: '' }), { code: 'INVALID_PARAMS' })
  assert.deepEqual(await client.request('browser.prepare'), { taskId: 'prepare-task', state: 'starting' })
  await assert.rejects(client.request('browser.prepare', { unexpected: true }), { code: 'INVALID_PARAMS' })
  assert.deepEqual(await client.request('browser.getAvailable', { ignoreCached: true }), {
    browser: 'test', executablePath: '/tmp/test-browser', options: { ignoreCached: true }
  })
  assert.deepEqual(await client.request('browser.setExecutable', { executablePath: '/tmp/custom-browser', browser: 'Custom' }), {
    browser: 'Custom', executablePath: '/tmp/custom-browser'
  })
  assert.deepEqual(savedExecutables, [{ executablePath: '/tmp/custom-browser', browser: 'Custom' }])
  await assert.rejects(client.request('browser.setExecutable', { browser: 'Custom' }), { code: 'INVALID_PARAMS' })
  assert.deepEqual(await client.request('browser.cancel', { taskId: 'browser-task' }), { taskId: 'browser-task', state: 'cancelled' })
  assert.deepEqual(cancelledBrowserTasks, ['browser-task'])
  await assert.rejects(client.request('browser.cancel', {}), { code: 'INVALID_PARAMS' })
  await assert.rejects(client.request('browser.cancel', { taskId: 'browser-task', extra: true }), { code: 'INVALID_PARAMS' })
  assert.deepEqual(await client.request('records.list', { resource: 'jobs' }), { items: [], total: 0, page: 1, pageSize: 10 })
  for (const forbidden of ['command', 'args', 'cwd', 'env']) {
    await assert.rejects(
      client.request('task.start', { workerId: 'auto', [forbidden]: 'forbidden' }),
      { code: 'INVALID_PARAMS' }
    )
  }
  await assert.rejects(
    client.request('task.start', { workerId: 'auto', options: { command: '/bin/sh' } }),
    { code: 'INVALID_PARAMS' }
  )
  const task = await client.request('task.start', { workerId: 'auto' })
  assert.equal(task.pid, 700)
  taskChildren[0].stdout.emit('data', 'token=do-not-log\nready\n')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await client.request('task.list'))[0].recentStdout[0], 'token=[redacted]')
  assert(events.some(({ event, data }) => event === 'task.progress' && data.line === 'token=[redacted]'))
  await client.request('task.stop', { workerId: 'auto' })
  assert(events.some(({ event }) => event === 'task.exited'))

  assert.equal((await client.request('approval.list')).length, 2)
  const createdApproval = await client.request('approval.create', {
    request: { id: 'approval-three', latestHrMessage: 'Can you confirm?', status: 'pending' }
  })
  assert.equal(createdApproval.created, true)
  assert.equal(createdApproval.request.id, 'approval-three')
  assert.equal((await client.request('approval.create', {
    request: { id: 'ignored-id', latestHrMessage: 'Can you confirm?', status: 'pending' }
  })).created, false)
  const createdApprovalEvents = events.filter(({ event, data }) => event === 'approval.required' && data.id === 'approval-three')
  assert.equal(createdApprovalEvents.length, 1)
  assert.equal((await client.request('approval.approve', { id: 'approval-one' })).status, 'approved_auto_reply')
  assert.equal((await client.request('approval.requireHuman', { id: 'approval-two', reason: 'review' })).status, 'human_required')
  assert(events.some(({ event, data }) => event === 'approval.required' && data.id === 'approval-two'))

  await client.close()
  await backend.stop()
  await assert.rejects(fs.lstat(runtimePaths.backendSocket), { code: 'ENOENT' })

  const migrated = await initDb(runtimePaths.databaseFile)
  try {
    const [{ name }] = await migrated.manager.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ggr_safety_state'")
    assert.equal(name, 'ggr_safety_state')
  } finally {
    await migrated.destroy()
  }

  const log = await fs.readFile(runtimePaths.backendLog, 'utf8')
  const records = log.trim().split('\n').map(JSON.parse)
  assert(records.some(({ correlationId }) => typeof correlationId === 'string' && correlationId.length > 0))
  assert(!log.includes('hidden'))
  assert(!log.includes('do-not-log'))
  assert.equal((await fs.stat(runtimePaths.backendLog)).mode & 0o777, 0o600)

} finally {
  await backend.stop().catch(() => {})
  await fs.rm(tempHome, { recursive: true, force: true })
}

{
  const logHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-logger-concurrency-'))
  const logPath = path.join(logHome, 'backend.jsonl')
  const logger = await createLogger({ filePath: logPath, maxBytes: 180 })
  try {
    await logger.write('info', 'prefill', { value: 'x'.repeat(80) })
    const settled = await Promise.allSettled([
      logger.write('info', 'concurrent-one', { value: 'a'.repeat(80) }),
      logger.write('info', 'concurrent-two', { value: 'b'.repeat(80) })
    ])
    assert(settled.every(({ status }) => status === 'fulfilled'))
    await logger.close()
    for (const target of [logPath, `${logPath}.1`]) {
      const content = await fs.readFile(target, 'utf8')
      for (const line of content.trim().split('\n').filter(Boolean)) JSON.parse(line)
      assert.equal((await fs.stat(target)).mode & 0o777, 0o600)
    }
  } finally {
    await logger.close().catch(() => {})
    await fs.rm(logHome, { recursive: true, force: true })
  }
}

{
  const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-config-concurrency-'))
  const service = createConfigService({ configDir: configHome })
  try {
    await Promise.all([
      service.write({ resource: 'opening_message', patch: { openingMessage: 'one' } }),
      service.write({ resource: 'reply_policy', patch: { replyPolicy: 'two' } })
    ])
    const data = JSON.parse(await fs.readFile(path.join(configHome, 'boss.json'), 'utf8'))
    assert.deepEqual(data, { openingMessage: 'one', replyPolicy: 'two' })
  } finally {
    await fs.rm(configHome, { recursive: true, force: true })
  }
}

{
  const cleanupHome = await fs.mkdtemp('/tmp/ggr-cleanup-')
  const paths = createRuntimePaths(cleanupHome)
  const calls = []
  const cleanupBackend = await createBackendServer({
    socketPath: paths.backendSocket,
    version: '0.1.0',
    runtimePaths: paths,
    services: {
      task: { list: () => [], stopAll: async () => { calls.push('task') } },
      approval: {},
      browser: { close: async () => { calls.push('browser'); throw new Error('browser close failed') } },
      records: { accountStatus: async () => ({ authenticated: false }), getDataSource: async () => {}, close: async () => { calls.push('records') } },
      config: { close: async () => { calls.push('config') } },
      logger: { write: async () => {}, close: async () => { calls.push('logger') } }
    }
  })
  try {
    await cleanupBackend.start()
    await assert.rejects(cleanupBackend.stop(), /browser close failed/)
    assert.deepEqual(calls, ['task', 'browser', 'records', 'config', 'logger'])
    await assert.rejects(fs.lstat(paths.backendSocket), { code: 'ENOENT' })
  } finally {
    await cleanupBackend.stop().catch(() => {})
    await fs.rm(cleanupHome, { recursive: true, force: true })
  }
}

{
  const cleanupHome = await fs.mkdtemp('/tmp/ggr-aggregate-')
  const paths = createRuntimePaths(cleanupHome)
  const calls = []
  const cleanupBackend = await createBackendServer({
    socketPath: paths.backendSocket,
    version: '0.1.0',
    runtimePaths: paths,
    services: {
      task: { list: () => [], stopAll: async () => { calls.push('task') } },
      approval: {},
      browser: { close: async () => { calls.push('browser'); throw new Error('browser close failed') } },
      records: { accountStatus: async () => ({ authenticated: false }), getDataSource: async () => {}, close: async () => { calls.push('records'); throw new Error('records close failed') } },
      config: { close: async () => { calls.push('config') } },
      logger: { write: async () => {}, close: async () => { calls.push('logger') } }
    }
  })
  try {
    await cleanupBackend.start()
    await assert.rejects(cleanupBackend.stop(), (error) => {
      assert(error instanceof AggregateError)
      assert.deepEqual(error.errors.map(({ message }) => message), ['browser close failed', 'records close failed'])
      return true
    })
    assert.deepEqual(calls, ['task', 'browser', 'records', 'config', 'logger'])
    await assert.rejects(fs.lstat(paths.backendSocket), { code: 'ENOENT' })
  } finally {
    await cleanupBackend.stop().catch(() => {})
    await fs.rm(cleanupHome, { recursive: true, force: true })
  }
}

{
  // macOS limits Unix-domain socket paths; keep this test socket below that limit.
  const delayedHome = await fs.mkdtemp('/tmp/ggr-backend-peer-')
  const paths = createRuntimePaths(delayedHome)
  const delayedBackend = await createBackendServer({
    socketPath: paths.backendSocket,
    version: '0.1.0',
    runtimePaths: paths,
    verifyPeer: () => new Promise((resolve) => setTimeout(() => resolve(true), 30))
  })
  try {
    await delayedBackend.start()
    const client = createGgrClient({ socketPath: paths.backendSocket, client: 'test', clientVersion: '1.0.0', requestTimeoutMs: 200 })
    await client.connect()
    await client.close()
  } finally {
    await delayedBackend.stop()
    await fs.rm(delayedHome, { recursive: true, force: true })
  }
}

{
  const policyHome = await fs.mkdtemp('/tmp/ggr-safety-rpc-')
  const paths = createRuntimePaths(policyHome)
  const reviewers = []
  let resumeCount = 0
  const policy = {
    async status() { return { status: 'PAUSED_RISK' } },
    getConfig() { return { chatPerHour: 5 } },
    updateConfig(patch) { return patch },
    async resume() {
      resumeCount++
      if (resumeCount === 2) {
        throw Object.assign(new Error('auto-chat is paused after reaching a quota and requires manual resume'), {
          code: 'PAUSED_QUOTA', data: { eligibleAt: null, reason: 'daily chat limit reached' }
        })
      }
      throw Object.assign(new Error('auto-chat risk cooldown is active'), {
        code: 'RISK_COOLDOWN_ACTIVE', data: { pausedUntil: '2026-07-17T00:00:00.000Z' }
      })
    },
    async preflightStart() { return { status: 'RUNNING' } },
    async approve({ id, actor }) { reviewers.push(actor); return { id, status: 'APPROVED' } },
    async reject({ id, actor, reason }) { reviewers.push(actor); return { id, status: 'REJECTED', reason } }
  }
  const backend = await createBackendServer({
    socketPath: paths.backendSocket,
    version: '0.1.0',
    runtimePaths: paths,
    services: {
      task: { list: () => [], start: async () => ({ workerId: 'auto', runRecordId: 1 }), stop: async () => {}, setUpdateDrain: () => {} },
      approval: { list: () => [], create: () => {}, approve: () => {}, requireHuman: () => {} },
      records: { accountStatus: async () => ({ authenticated: true }), getDataSource: async () => {}, close: async () => {} },
      browser: { close: async () => {} },
      logger: { write: async () => {}, close: async () => {} },
      policy,
      safetyStore: { getApproval: async (id) => id === 'policy-approval' ? { id, kind: 'AUTO_CHAT' } : null }
    }
  })
  try {
    await backend.start()
    const [beforeHandshake] = await rawSession(paths.backendSocket, [
      { id: 'before-handshake', method: 'system.health', params: {} }
    ])
    assert.equal(beforeHandshake.error.code, 'HANDSHAKE_REQUIRED')

    const [, resume, quotaResume, approve] = await rawSession(paths.backendSocket, [
      { id: 'handshake', method: 'system.handshake', params: { client: 'socket-client', clientVersion: '9.9.9', protocolVersion: 1 } },
      { id: 'resume', method: 'safety.resume', params: {} },
      { id: 'quota-resume', method: 'safety.resume', params: {} },
      { id: 'approve', method: 'approval.approve', params: { id: 'policy-approval' } }
    ])
    assert.deepEqual(resume.error, {
      code: 'RISK_COOLDOWN_ACTIVE',
      message: 'auto-chat risk cooldown is active',
      data: { pausedUntil: '2026-07-17T00:00:00.000Z' }
    })
    assert.deepEqual(quotaResume.error, {
      code: 'PAUSED_QUOTA',
      message: 'auto-chat is paused after reaching a quota and requires manual resume',
      data: { eligibleAt: null, reason: 'daily chat limit reached' }
    })
    assert.deepEqual(approve.result, { id: 'policy-approval', status: 'APPROVED' })
    assert.deepEqual(reviewers, [{ client: 'socket-client', clientVersion: '9.9.9' }])

    const [actorHandshake, actorRequest] = await rawSession(paths.backendSocket, [
      { id: 'actor-handshake', method: 'system.handshake', params: { client: 'socket-client', clientVersion: '9.9.9', protocolVersion: 1 } },
      { id: 'actor-request', method: 'approval.approve', params: { id: 'policy-approval', actor: { client: 'forged', clientVersion: '0.0.0' } } }
    ])
    assert.deepEqual(actorHandshake.result.capabilities, ['safety-policy-v1'])
    assert.equal(actorRequest.error.code, 'INVALID_PARAMS')
    assert.equal(reviewers.length, 1)
  } finally {
    await backend.stop().catch(() => {})
    await fs.rm(policyHome, { recursive: true, force: true })
  }
}

{
  const workerControlHome = await fs.mkdtemp('/tmp/ggr-worker-control-server-')
  const paths = createRuntimePaths(workerControlHome)
  const children = []
  const exited = []
  let reviewer
  const backend = await createBackendServer({
    socketPath: paths.backendSocket,
    version: '0.1.0',
    runtimePaths: paths,
    services: {
      workerEntries: { geekAutoStartWithBossMain: '/tmp/auto-chat.mjs' },
      spawnProcess: () => {
        const child = new EventEmitter()
        child.pid = 900 + children.length
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = (signal) => { queueMicrotask(() => child.emit('exit', null, signal)); return true }
        children.push(child)
        return child
      },
      stopTimeoutMs: 10,
      browser: { close: async () => {} },
      llm: { request: async () => ({}) }
    }
  })
  try {
    await backend.start()
    const client = createGgrClient({ socketPath: paths.backendSocket, client: 'test', clientVersion: '1.0.0' })
    await client.connect()
    client.onEvent((event) => { if (event.event === 'task.exited') exited.push(event.data) })

    await client.request('task.start', { workerId: 'geekAutoStartWithBossMain' })
    await client.request('task.stop', { workerId: 'geekAutoStartWithBossMain' })
    assert.equal((await client.request('safety.status')).status, 'IDLE',
      'a manually stopped auto-chat worker must release its backend safety run')

    await client.request('task.start', { workerId: 'geekAutoStartWithBossMain' })
    const child = children.at(-1)
    const candidateReply = new Promise((resolve) => { child.send = resolve })
    child.emit('message', {
      ggrWorkerControl: 1,
      requestId: 'candidate-1',
      type: 'candidate.propose',
      data: { jobId: 'job-smoke', companyId: 'company-smoke', bossId: 'boss-smoke' }
    })
    const candidateResponse = await Promise.race([
      candidateReply,
      new Promise((_, reject) => setTimeout(() => reject(new Error('server did not route worker candidate IPC')), 100))
    ])
    assert.equal(candidateResponse.ok, true)
    assert.equal(typeof candidateResponse.data.id, 'string')
    assert.equal(candidateResponse.data.context.workerId, 'geekAutoStartWithBossMain')
    assert.equal((await client.request('approval.get', { id: candidateResponse.data.id })).status, 'PENDING')

    reviewer = createGgrClient({
      socketPath: paths.backendSocket,
      client: 'ggr-cli',
      clientVersion: '1.0.0'
    })
    await reviewer.connect()
    assert.equal((await reviewer.request('approval.approve', { id: candidateResponse.data.id })).status, 'APPROVED')

    const reply = new Promise((resolve) => { child.send = resolve })
    child.emit('message', {
      ggrWorkerControl: 1,
      requestId: 'risk-1',
      type: 'risk.detected',
      data: { statusCode: 403, reason: 'Forbidden' }
    })
    const response = await Promise.race([
      reply,
      new Promise((_, reject) => setTimeout(() => reject(new Error('server did not route worker risk IPC')), 100))
    ])

    assert.deepEqual(response, {
      ggrWorkerControl: 1,
      requestId: 'risk-1',
      ok: true,
      data: await client.request('safety.status')
    })
    assert.equal((await client.request('safety.status')).status, 'PAUSED_RISK')
    assert.equal(children.length, 2, 'risk stop must not restart the auto-chat worker')
    assert(exited.some((event) => event.workerId === 'geekAutoStartWithBossMain' && event.restartSuppressed === true))
    await reviewer.close()
    reviewer = null
    await client.close()
  } finally {
    await reviewer?.close().catch(() => {})
    await backend.stop().catch(() => {})
    await fs.rm(workerControlHome, { recursive: true, force: true })
  }
}

console.log('ggr backend server check passed')
