import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createApprovalService } from '../lib/services/approval-service.mjs'
import { createSafetyPolicyService } from '../lib/services/safety-policy-service.mjs'
import { createTaskService } from '../lib/services/task-service.mjs'
import { createWorkerControlService } from '../lib/services/worker-control-service.mjs'
import { runAutoChatEntry } from '../lib/workers/auto-chat.mjs'
import { createWorkerReporter } from '../lib/workers/worker-reporter.mjs'

function fakeChild(pid, { exitOnSignal = true } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killSignals = []
  child.kill = (signal) => {
    child.killSignals.push(signal)
    if (exitOnSignal || signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, signal))
    return true
  }
  child.sent = []
  child.send = (message) => {
    child.sent.push(message)
    return true
  }
  return child
}

{
  let state = null
  let now = new Date('2026-07-16T00:00:00.000Z')
  const store = {
    readState: async () => state,
    transaction: async (callback) => callback({
      readState: async () => state,
      upsertState: async ({ scopeKey, state: next }) => {
        state = { scopeKey, state: structuredClone(next) }
        return state
      },
      insertEvent: async () => ({})
    })
  }
  const policy = createSafetyPolicyService({
    store,
    accountHealthCheck: async () => true,
    now: () => now,
    config: { riskCooldownMs: 1_000 }
  })
  const spawnCalls = []
  const service = createTaskService({
    spawnProcess: () => {
      spawnCalls.push(true)
      return fakeChild(301)
    },
    workerEntries: { geekAutoStartWithBossMain: '/tmp/auto-chat.mjs' },
    admitStart: ({ runRecordId }) => policy.preflightStart({ runRecordId })
  })

  await policy.stopForQuota({ reason: 'daily chat limit reached' })
  const quotaPause = await policy.status()
  await assert.rejects(
    service.start({ workerId: 'geekAutoStartWithBossMain' }),
    (error) => error.code === 'PAUSED_QUOTA' && error.data?.eligibleAt === null
  )
  assert.equal(spawnCalls.length, 0, 'quota pauses must reject before a worker process is spawned')
  assert.deepEqual(await policy.status(), quotaPause, 'quota admission rejection must not change the paused policy state')

  await policy.resume()

  await policy.detectRisk({ statusCode: 403 })
  await assert.rejects(service.start({ workerId: 'geekAutoStartWithBossMain' }), { code: 'RISK_COOLDOWN_ACTIVE' })
  assert.equal(spawnCalls.length, 0, 'risk cooldown must reject before a worker process is spawned')

  now = new Date(now.getTime() + 1_001)
  await assert.rejects(service.start({ workerId: 'geekAutoStartWithBossMain' }), { code: 'PAUSED_RISK' })
  assert.equal(spawnCalls.length, 0, 'expired risk pauses still require manual resume before spawning')

  await policy.resume()
  await policy.detectRisk({ code: 'INVALID_LOGIN' })
  await assert.rejects(service.start({ workerId: 'geekAutoStartWithBossMain' }), { code: 'INVALID_LOGIN_PAUSED' })
  assert.equal(spawnCalls.length, 0, 'invalid-login pauses must reject before a worker process is spawned')

  await policy.resume()
  const started = await service.start({ workerId: 'geekAutoStartWithBossMain' })
  assert.equal(spawnCalls.length, 1, 'an admitted auto-chat start creates exactly one child process')
  assert.equal((await policy.status()).runRecordId, String(started.runRecordId), 'policy state must use the worker run record id')
  await service.stop({ workerId: 'geekAutoStartWithBossMain' })
}

{
  const spawnCalls = []
  const child = fakeChild(98)
  const received = []
  const service = createTaskService({
    spawnProcess: (...args) => { spawnCalls.push(args); return child },
    workerEntries: { geekAutoStartWithBossMain: '/tmp/auto-chat.mjs' },
    workerControl: {
      handle: async (message) => {
        received.push(message)
        return { state: 'RUNNING' }
      }
    }
  })

  const started = await service.start({ workerId: 'geekAutoStartWithBossMain' })
  assert.deepEqual(spawnCalls[0][2].stdio, ['ignore', 'pipe', 'pipe', 'ipc'], 'auto-chat workers must receive a private IPC fd')
  child.emit('message', {
    ggrWorkerControl: 1,
    requestId: 'state-1',
    type: 'agent.state',
    data: {},
    workerId: 'spoofed-worker',
    runRecordId: 'spoofed-run'
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(received, [{ workerId: 'geekAutoStartWithBossMain', runRecordId: started.runRecordId, type: 'agent.state', data: {} }], 'worker identity must be derived from its child record')
  assert.deepEqual(child.sent, [{ ggrWorkerControl: 1, requestId: 'state-1', ok: true, data: { state: 'RUNNING' } }], 'valid IPC requests must receive correlated responses')
  child.emit('message', { ggrWorkerControl: 1, requestId: 'bad', type: 'not.allowed', data: {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(child.sent.length, 1, 'invalid IPC messages must be ignored')
  await service.stop({ workerId: 'geekAutoStartWithBossMain' })
}

{
  const events = []
  const child = fakeChild(97)
  let service
  const workerControl = {
    handle: async ({ type, workerId }) => {
      if (type === 'risk.detected') await service.stop({ workerId, policyStop: true })
      return { paused: true }
    }
  }
  service = createTaskService({
    spawnProcess: () => child,
    workerEntries: { geekAutoStartWithBossMain: '/tmp/auto-chat.mjs' },
    workerControl,
    emit: (event, data) => events.push({ event, data })
  })

  await service.start({ workerId: 'geekAutoStartWithBossMain' })
  child.emit('message', { ggrWorkerControl: 1, requestId: 'risk-1', type: 'risk.detected', data: { statusCode: 403 } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(child.killSignals, ['SIGTERM'])
  const exit = events.find(({ event }) => event === 'task.exited')
  assert.equal(exit?.data.restartSuppressed, true, 'policy stops must be visible as intentional restart suppression')
}

{
  const child = fakeChild(96, { exitOnSignal: false })
  let control
  const service = createTaskService({
    spawnProcess: () => child,
    workerEntries: { geekAutoStartWithBossMain: '/tmp/auto-chat.mjs' },
    workerControl: { handle: (message) => control.handle(message) },
    stopTimeoutMs: 50
  })
  control = createWorkerControlService({
    policy: { detectRisk: async () => ({ status: 'PAUSED_RISK' }) },
    task: service
  })
  await service.start({ workerId: 'geekAutoStartWithBossMain' })
  const reply = new Promise((resolve) => {
    child.send = (message) => {
      child.sent.push(message)
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))
      resolve(message)
      return true
    }
  })
  child.emit('message', { ggrWorkerControl: 1, requestId: 'risk-ack-1', type: 'risk.detected', data: { statusCode: 403 } })
  assert.deepEqual(await Promise.race([
    reply,
    new Promise((_, reject) => setTimeout(() => reject(new Error('risk reply waited for worker exit')), 25))
  ]), {
    ggrWorkerControl: 1,
    requestId: 'risk-ack-1',
    ok: true,
    data: { status: 'PAUSED_RISK' }
  }, 'risk persistence must acknowledge IPC before the worker is stopped')
}

{
  const events = []
  const child = fakeChild(99)
  const service = createTaskService({
    spawnProcess: () => child,
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: (event, data) => events.push({ event, data })
  })
  const started = await service.start({ workerId: 'auto' })
  assert.equal(typeof started.runRecordId, 'number', 'backend task starts must expose a durable run correlation id')
  assert.equal(started.runtimeStorage.stepStatusMapByStepId['worker-launch'].runRecordId, started.runRecordId)
  const reporter = createWorkerReporter({ write: (line) => child.stdout.emit('data', line) })
  reporter.emit('task.progress', {
    workerId: 'auto',
    state: 'working',
    token: 'a"b',
    message: 'request failed token=event-secret-fragment password=event-password-fragment'
  })
  assert.deepEqual(events[0], {
    event: 'task.progress',
    data: {
      workerId: 'auto',
      runRecordId: started.runRecordId,
      state: 'working',
      token: '[redacted]',
      message: 'request failed token=[redacted]'
    }
  })
  const [reconstructed] = service.list()
  assert.equal(reconstructed.runRecordId, started.runRecordId, 'task.list must reconstruct correlation after an Electron restart')
  assert.equal(reconstructed.runtimeStorage.runRecordId, started.runRecordId)
  assert(!JSON.stringify(events[0]).includes('event-secret'))
  assert(!JSON.stringify(events[0]).includes('event-password'))
  assert.deepEqual(service.list()[0].recentStdout, [])
  child.stdout.emit('data', '{"ggrWorkerEvent":1,"event":"not.allowed","data":{"password":"nope"}}\n')
  assert.equal(service.list()[0].recentStdout[0], '{"ggrWorkerEvent":1,"event":"not.allowed","data":{"password":"[redacted]"}}')
  await service.stop({ workerId: 'auto' })
}

{
  const events = []
  const child = fakeChild(100, { exitOnSignal: false })
  const service = createTaskService({
    spawnProcess: () => child,
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: (event, data) => events.push({ event, data }),
    diagnosticLineBytes: 512,
    diagnosticStreamBytes: 2048
  })
  await service.start({ workerId: 'auto' })
  child.stdout.emit('data', 'token="unclosed-secret-value\n')
  child.stdout.emit('data', 'password=unquoted-secret-value\n')
  child.stdout.emit('data', 'to')
  child.stdout.emit('data', 'ken="split-secret-value"\n')
  child.stdout.emit('data', `${JSON.stringify({
    ggrWorkerEvent: 1,
    event: 'not.allowed',
    data: {
      token: ['first-secret-fragment', 'second-secret-fragment'],
      password: { backup: 'backup-secret-fragment' },
      safe: 'shown'
    }
  })}\n`)
  child.stdout.emit('data', 'prefix token="escaped-secret-fragment-\\"second-secret-fragment,backup-secret-fragment\n')
  child.stdout.emit('data', `${JSON.stringify({ message: 'request failed token=embedded-secret-fragment', safe: 'shown' })}\n`)
  child.stdout.emit('data', `${JSON.stringify(['credential=array-secret-fragment', 'safe'])}\n`)

  const running = JSON.stringify(service.list())
  for (const secret of [
    'unclosed-secret', 'unquoted-secret', 'split-secret', 'first-secret',
    'second-secret', 'backup-secret', 'escaped-secret', 'embedded-secret', 'array-secret'
  ]) assert(!running.includes(secret), `recent diagnostics leaked ${secret}`)
  assert(service.list()[0].recentStdout.every((line) => Buffer.byteLength(line) <= 512))
  const emitted = JSON.stringify(events)
  for (const secret of [
    'unclosed-secret', 'unquoted-secret', 'split-secret', 'first-secret',
    'second-secret', 'backup-secret', 'escaped-secret', 'embedded-secret', 'array-secret'
  ]) assert(!emitted.includes(secret), `diagnostic event leaked ${secret}`)

  child.stdout.emit('data', `credential="oversized-secret-prefix-${'x'.repeat(1024 * 1024)}`)
  child.emit('exit', 1, null)
  assert(!JSON.stringify(events).includes('oversized-secret-prefix'))
  await service.stopAll()
}

{
  const spawnCalls = []
  const child = fakeChild(101)
  const service = createTaskService({
    spawnProcess: (...args) => { spawnCalls.push(args); return child },
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: () => {},
    stopTimeoutMs: 10
  })

  await assert.rejects(
    service.start({ workerId: 'auto', options: { command: '/bin/sh', args: ['-c', 'id'] } }),
    /Unsupported task start option/
  )

  const [first, second] = await Promise.all([
    service.start({ workerId: 'auto' }),
    service.start({ workerId: 'auto' })
  ])
  assert.equal(first.pid, second.pid)
  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0].slice(0, 2), [process.execPath, ['/tmp/auto.mjs']])

  await assert.rejects(
    service.start({ workerId: 'unknown', command: '/bin/sh', args: ['-c', 'id'], cwd: '/tmp', env: {} }),
    /Unsupported worker id/
  )
  assert.equal(spawnCalls.length, 1)

  await service.stop({ workerId: 'auto' })
  assert.deepEqual(child.killSignals, ['SIGTERM'])

  await service.start({ workerId: 'auto', options: { headless: true } })
  assert.equal(spawnCalls[1][2].env.GGR_HEADLESS, 'true', 'headless task start must be configured by the backend')
  await service.stop({ workerId: 'auto' })
}

{
  const child = fakeChild(102, { exitOnSignal: false })
  const service = createTaskService({
    spawnProcess: () => child,
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: () => {},
    stopTimeoutMs: 5
  })
  await service.start({ workerId: 'auto' })
  const stopping = service.stop({ workerId: 'auto' })
  assert.equal(service.list()[0].status, 'stopping')
  await stopping
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL'])
}

{
  const child = fakeChild(103)
  const service = createTaskService({
    spawnProcess: () => child,
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: () => {}
  })
  // The supervisor atomically enables this before it observes active tasks.
  // Any task admission racing that observation is rejected by the backend.
  service.setUpdateDrain({ enabled: true })
  await assert.rejects(service.start({ workerId: 'auto' }), { code: 'UPDATE_DRAINING' })
  assert.equal(service.list().length, 0)
  service.setUpdateDrain({ enabled: false })
  await service.start({ workerId: 'auto' })
  await service.stop({ workerId: 'auto' })
}

{
  const children = []
  const service = createTaskService({
    spawnProcess: () => {
      const child = fakeChild(104, { exitOnSignal: false })
      children.push(child)
      return child
    },
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: () => {}
  })
  await service.start({ workerId: 'auto' })

  const stopping = service.stop({ workerId: 'auto' })
  const queuedStart = service.start({ workerId: 'auto' })
  service.setUpdateDrain({ enabled: true })
  children[0].emit('exit', null, 'SIGTERM')

  await stopping
  await assert.rejects(queuedStart, { code: 'UPDATE_DRAINING' })
  assert.equal(children.length, 1, 'a start queued behind a stop must not launch while draining')
  assert.deepEqual(service.list(), [])
}

{
  const events = []
  const child = fakeChild(150, { exitOnSignal: false })
  const service = createTaskService({
    spawnProcess: () => child,
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: (event, data) => events.push({ event, data }),
    stopTimeoutMs: 5,
    diagnosticLineBytes: 32,
    diagnosticStreamBytes: 64
  })
  await service.start({ workerId: 'auto' })
  child.stdout.emit('data', `${'a'.repeat(20)}token=boundary-secret-that-must-not-leak`)
  child.stdout.emit('data', 'x'.repeat(1024 * 1024))
  child.stdout.emit('data', '\n')
  for (let index = 0; index < 10; index++) child.stdout.emit('data', `${String(index).repeat(30)}\n`)

  const [running] = service.list()
  assert(running.recentStdout.every((line) => Buffer.byteLength(line) <= 32))
  assert(running.recentStdout.reduce((bytes, line) => bytes + Buffer.byteLength(line), 0) <= 64)
  assert(events.filter(({ event }) => event === 'task.progress').every(({ data }) => Buffer.byteLength(data.line) <= 32))
  assert(!JSON.stringify(events).includes('boundary-secret'))

  child.stderr.emit('data', `password=no-newline-secret${'z'.repeat(1024 * 1024)}`)
  child.emit('exit', 0, null)
  const stderrProgress = events.find(({ event, data }) => event === 'task.progress' && data.stream === 'stderr')
  assert(stderrProgress)
  assert(Buffer.byteLength(stderrProgress.data.line) <= 32)
  assert(!JSON.stringify(events).includes('no-newline-secret'))
}

{
  const children = []
  const events = []
  const service = createTaskService({
    spawnProcess: () => {
      const child = fakeChild(200 + children.length)
      children.push(child)
      return child
    },
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: (event, data) => events.push({ event, data }),
    stopTimeoutMs: 5
  })

  await service.start({ workerId: 'auto' })
  const child = children[0]
  const longOutput = Array.from({ length: 90 }, (_, index) => `line-${index}`).join('\n')
  child.stdout.emit('data', `${longOutput}\ntoken=super-secret\n`)
  child.stdout.emit('data', 'token=chunk-')
  child.stdout.emit('data', 'secret\n')
  child.stdout.emit('data', '{"token":"json-secret","safe":"ok"}\n')
  child.stderr.emit('data', 'password: hidden-value\n')

  const [running] = service.list()
  assert.equal(running.recentStdout.length, 80)
  assert.equal(running.recentStdout.at(-2), 'token=[redacted]')
  assert.equal(running.recentStdout.at(-1), '{"token":"[redacted]","safe":"ok"}')
  assert.equal(running.recentStderr.at(-1), 'password: [redacted]')
  assert(!JSON.stringify(events).includes('super-secret'))
  assert(!JSON.stringify(events).includes('hidden-value'))
  assert(!JSON.stringify(events).includes('chunk-secret'))
  assert(!JSON.stringify(events).includes('json-secret'))

  const stopping = service.stop({ workerId: 'auto' })
  await stopping
  child.emit('close', null, 'SIGTERM')
  child.emit('error', new Error('late error'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(children.length, 1)
  const exits = events.filter(({ event }) => event === 'task.exited')
  assert.equal(exits.length, 1)
  assert.equal(exits[0].data.restarting, false)
  assert.equal(service.list().length, 0)
  assert(events.some(({ event, data }) => event === 'task.progress' && data.stream === 'stdout'))
}

{
  const children = []
  const service = createTaskService({
    spawnProcess: () => {
      const child = fakeChild(300 + children.length)
      children.push(child)
      return child
    },
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: () => {},
    stopTimeoutMs: 5,
    scheduleRestart(callback) { queueMicrotask(callback) }
  })
  await service.start({ workerId: 'auto' })
  children[0].emit('exit', 1, null)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(children.length, 2)
  assert.equal(service.list()[0].restartCount, 1)
  await service.stopAll()
  assert.equal(children.length, 2)
}

{
  const children = []
  const scheduled = []
  const events = []
  const service = createTaskService({
    spawnProcess: () => {
      const child = fakeChild(400 + children.length)
      children.push(child)
      return child
    },
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: (event, data) => events.push({ event, data }),
    now: () => 1_000,
    scheduleRestart(callback, delayMs) {
      scheduled.push({ callback, delayMs })
      return scheduled.length
    },
    restartPolicy: { maxRestarts: 2, windowMs: 60_000, initialDelayMs: 1_000, maxDelayMs: 10_000 }
  })

  await service.start({ workerId: 'auto' })
  children[0].emit('exit', 1, null)
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [1_000], 'the first retry must be delayed')
  assert.equal(children.length, 1, 'a crash must not immediately spawn a replacement')
  scheduled.shift().callback()
  assert.equal(children.length, 2)

  children[1].emit('exit', 1, null)
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [2_000], 'retries must back off exponentially')
  scheduled.shift().callback()
  assert.equal(children.length, 3)

  children[2].emit('exit', 1, null)
  assert.equal(scheduled.length, 0, 'the circuit breaker must suppress another restart')
  assert(events.some(({ event, data }) => event === 'task.exited' && data.restartSuppressed === true), 'the suppressed restart must be observable')
}

{
  let state = null
  const children = []
  const scheduled = []
  const events = []
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-policy-restart-'))
  const exitHistoryFile = path.join(tempDir, 'private', 'task-exits.json')
  const store = {
    readState: async () => state,
    transaction: async (callback) => callback({
      readState: async () => state,
      upsertState: async ({ scopeKey, state: next }) => {
        state = { scopeKey, state: structuredClone(next) }
        return state
      },
      insertEvent: async () => ({})
    })
  }
  const policy = createSafetyPolicyService({ store, accountHealthCheck: async () => true })
  const service = createTaskService({
    spawnProcess: () => {
      const child = fakeChild(450 + children.length)
      children.push(child)
      return child
    },
    workerEntries: { geekAutoStartWithBossMain: '/tmp/auto-chat.mjs' },
    emit: (event, data) => events.push({ event, data }),
    admitStart: ({ runRecordId }) => policy.preflightStart({ runRecordId }),
    exitHistoryFile,
    scheduleRestart(callback, delayMs) {
      scheduled.push({ callback, delayMs })
      return scheduled.length
    },
    restartPolicy: { maxRestarts: 1, windowMs: 60_000, initialDelayMs: 1, maxDelayMs: 1 }
  })
  try {
    await service.start({ workerId: 'geekAutoStartWithBossMain' })
    children[0].emit('exit', 1, null)
    assert.equal(scheduled.length, 1, 'a failed auto-chat run must schedule one restart admission')

    await policy.stopForQuota({ reason: 'quota reached before restart' })
    await scheduled.shift().callback()

    assert.equal(children.length, 1, 'a policy pause before the restart callback must create no replacement child')
    const suppressed = events.find(({ event, data }) => event === 'task.exited' && data.restartSuppressed === true)
    assert.equal(suppressed?.data.restartSuppressionCode, 'PAUSED_QUOTA')
    const persisted = JSON.parse(await fs.readFile(exitHistoryFile, 'utf8'))
    assert.equal(persisted.geekAutoStartWithBossMain.restartSuppressed, true)
    assert.equal(persisted.geekAutoStartWithBossMain.restartSuppressionCode, 'PAUSED_QUOTA')
  } finally {
    await service.stopAll()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-task-safety-stop-'))
  const exitHistoryFile = path.join(tempDir, 'private', 'task-exits.json')
  const children = []
  const events = []
  const service = createTaskService({
    spawnProcess: () => {
      const child = fakeChild(550 + children.length)
      children.push(child)
      return child
    },
    workerEntries: { geekAutoStartWithBossMain: '/tmp/auto-chat.mjs' },
    emit: (event, data) => events.push({ event, data }),
    exitHistoryFile,
    scheduleRestart(callback) { queueMicrotask(callback) }
  })
  try {
    await service.start({ workerId: 'geekAutoStartWithBossMain' })
    const taskReporter = createWorkerReporter({ write: (line) => children[0].stdout.emit('data', line) })
    await assert.rejects(runAutoChatEntry({
      createRuntime: async () => { throw Object.assign(new Error('Boss cookies are required'), { code: 'SAFETY_POLICY_STOP' }) },
      taskReporter,
      shouldStop: async () => false
    }), { code: 'SAFETY_POLICY_STOP' })
    assert.deepEqual(events.filter(({ event, data }) => event === 'task.progress' && data.state === 'runtime-error').map(({ data }) => ({
      code: data.code,
      message: data.message
    })), [{
      code: 'SAFETY_POLICY_STOP',
      message: 'Boss cookies are required'
    }])
    children[0].emit('exit', 1, null)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(children.length, 1, 'a safety policy stop must not spawn a replacement worker')
    const [{ data: exited }] = events.filter(({ event }) => event === 'task.exited')
    assert.equal(exited.restartSuppressed, true)
    assert.equal(exited.restartSuppressionReason, 'SAFETY_POLICY_STOP')
    const persisted = JSON.parse(await fs.readFile(exitHistoryFile, 'utf8'))
    assert.equal(persisted.geekAutoStartWithBossMain.restartSuppressionReason, 'SAFETY_POLICY_STOP')
  } finally {
    await service.stopAll()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-task-exits-'))
  const exitHistoryFile = path.join(tempDir, 'private', 'task-exits.json')
  const children = []
  const scheduled = []
  const service = createTaskService({
    spawnProcess: () => {
      const child = fakeChild(500 + children.length)
      children.push(child)
      return child
    },
    workerEntries: { auto: '/tmp/auto.mjs' },
    emit: () => {},
    exitHistoryFile,
    now: () => 1_000,
    scheduleRestart(callback) { scheduled.push(callback); return scheduled.length },
    restartPolicy: { maxRestarts: 1, windowMs: 60_000, initialDelayMs: 1, maxDelayMs: 1 }
  })
  try {
    await service.start({ workerId: 'auto' })
    children[0].stdout.emit('data', `${JSON.stringify({
      ggrWorkerEvent: 1,
      event: 'task.progress',
      data: { workerId: 'auto', state: 'runtime-error', code: 'AUTO_CHAT_FAILED', message: 'navigation failed', closeError: { message: 'browser close failed' } }
    })}\n`)
    children[0].emit('exit', 1, null)
    scheduled.shift()()

    const [restarted] = service.list()
    assert.equal(restarted.pid, 501)
    assert.equal(restarted.lastExit.workerId, 'auto')
    assert.equal(restarted.lastExit.code, 1)
    assert.equal(restarted.lastExit.signal, null)
    assert.equal(restarted.lastExit.restartSuppressed, false)
    assert.equal(restarted.lastExit.error, 'navigation failed')
    assert.equal(restarted.lastExit.closeError, 'browser close failed')
    assert.equal(restarted.lastExit.unexpected, true)

    const persisted = JSON.parse(await fs.readFile(exitHistoryFile, 'utf8'))
    assert.equal(persisted.auto.code, 1)
    assert.equal(persisted.auto.signal, null)
    assert.equal(persisted.auto.restartSuppressed, false)
    assert.equal(persisted.auto.error, 'navigation failed')
    assert.equal(persisted.auto.closeError, 'browser close failed')

    const afterBackendRestart = createTaskService({
      spawnProcess: () => { throw new Error('must not launch while reading task history') },
      workerEntries: { auto: '/tmp/auto.mjs' },
      emit: () => {},
      exitHistoryFile
    })
    assert.deepEqual(afterBackendRestart.list(), [{
      workerId: 'auto',
      status: 'failed',
      pid: null,
      startedAt: null,
      restartCount: 0,
      runRecordId: null,
      runtimeStorage: { runRecordId: null, stepStatusMapByStepId: {} },
      recentStdout: [],
      recentStderr: [],
      lastError: 'navigation failed',
      lastExit: persisted.auto
    }])
  } finally {
    await service.stopAll()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

{
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-approvals-'))
  const queueFilePath = path.join(tempDir, 'private', 'queue.json')
  const events = []
  const service = createApprovalService({
    queueFilePath,
    emit: (event, data) => events.push({ event, data })
  })
  try {
    await fs.mkdir(path.dirname(queueFilePath), { recursive: true })
    await fs.writeFile(queueFilePath, JSON.stringify([
      { id: 'one', status: 'pending', latestHrMessage: 'hello' },
      { id: 'two', status: 'pending', latestHrMessage: 'world' }
    ]))

    assert.deepEqual((await service.list()).map(({ id }) => id), ['one', 'two'])
    assert.equal((await fs.stat(queueFilePath)).mode & 0o777, 0o600)
    const [approved, human] = await Promise.all([
      service.approve({ id: 'one' }),
      service.requireHuman({ id: 'two', reason: 'ambiguous' })
    ])
    assert.equal(approved.status, 'approved_auto_reply')
    assert.equal(human.status, 'human_required')
    assert.equal(human.reviewReason, 'ambiguous')
    assert.deepEqual(await service.list(), [])
    assert.equal((await fs.stat(queueFilePath)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(path.dirname(queueFilePath))).mode & 0o777, 0o700)
    assert.deepEqual(events, [{ event: 'approval.required', data: human }])
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

console.log('ggr backend task service check passed')
