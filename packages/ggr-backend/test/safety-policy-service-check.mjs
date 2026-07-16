import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { initDb } from '@geekgeekrun/sqlite-plugin'
import {
  AUTO_CHAT_SCOPE,
  createSafetyPolicyService
} from '../lib/services/safety-policy-service.mjs'
import { createSafetyStore } from '../lib/services/safety-store.mjs'

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-safety-policy-'))
const databaseFile = path.join(tempHome, 'database.sqlite')
const database = await initDb(databaseFile)
let currentTime = new Date('2026-07-16T00:00:00.000Z')
const emitted = []
const store = createSafetyStore({ getDataSource: async () => database, now: () => currentTime })
const candidate = Object.freeze({
  jobId: 'job-one',
  companyName: 'Acme Incorporated',
  bossId: 'boss-one',
  workerId: 'worker-one',
  runRecordId: 99
})
const companyKey = createHash('sha256').update(candidate.companyName).digest('hex')
const policy = createSafetyPolicyService({
  store,
  emit: (type, payload) => emitted.push({ type, payload }),
  accountHealthCheck: async () => true,
  now: () => currentTime,
  randomBytes: (size) => Buffer.alloc(size, 7),
  config: { browsePerDay: 2, chatPerHour: 2, chatPerDay: 3, companyCooldownMs: 10_000, riskCooldownMs: 30_000, approvalTtlMs: 1_000 }
})

function advance(milliseconds) {
  currentTime = new Date(currentTime.getTime() + milliseconds)
}

try {
  await store.initialize()

  assert.equal(AUTO_CHAT_SCOPE, 'auto-chat')
  assert.deepEqual(await policy.status(), {
    scopeKey: AUTO_CHAT_SCOPE,
    status: 'IDLE',
    pausedUntil: null,
    reason: null,
    runRecordId: null
  })
  assert.equal((await policy.getConfig()).chatPerHour, 2)
  assert.equal((await policy.updateConfig({ chatPerHour: 1 })).chatPerHour, 1)
  await policy.updateConfig({ chatPerHour: 2 })
  assert.throws(() => policy.updateConfig({ chatPerHour: 0 }), (error) => error.code === 'INVALID_SAFETY_CONFIG')

  await policy.preflightStart({ runRecordId: candidate.runRecordId })
  await policy.recordBrowse({ runRecordId: candidate.runRecordId, jobId: 'browse-one' })
  await policy.recordBrowse({ runRecordId: candidate.runRecordId, jobId: 'browse-two' })
  await assert.rejects(
    policy.recordBrowse({ runRecordId: candidate.runRecordId, jobId: 'browse-three' }),
    (error) => error.code === 'BROWSE_DAILY_QUOTA_EXCEEDED'
  )

  const expired = await policy.createAutoChatApproval(candidate)
  advance(1_001)
  await assert.rejects(policy.approve({ id: expired.id, actor: { client: 'ggr-cli', version: 'test' } }), (error) => error.code === 'APPROVAL_EXPIRED')
  await assert.rejects(
    policy.consumeGrant({ grant: expired.grantForWorker, ...candidate }),
    (error) => error.code === 'APPROVAL_EXPIRED'
  )

  const approval = await policy.createAutoChatApproval(candidate)
  await policy.approve({ id: approval.id, actor: { client: 'ggr-cli', version: 'test' } })
  await assert.rejects(
    policy.consumeGrant({ grant: approval.grantForWorker, ...candidate, runRecordId: 100 }),
    (error) => error.code === 'APPROVAL_CONTEXT_MISMATCH'
  )
  await assert.rejects(
    policy.consumeGrant({ grant: approval.grantForWorker, ...candidate, workerId: 'other-worker' }),
    (error) => error.code === 'APPROVAL_CONTEXT_MISMATCH'
  )
  const [first, second] = await Promise.allSettled([
    policy.consumeGrant({ grant: approval.grantForWorker, ...candidate }),
    policy.consumeGrant({ grant: approval.grantForWorker, ...candidate })
  ])
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.equal(second.reason.code, 'APPROVAL_ALREADY_CONSUMED')
  await policy.recordChatResult({ ...candidate, outcome: 'UNKNOWN' })

  const nextCandidate = { ...candidate, jobId: 'job-two', companyName: 'Beta Corp' }
  const nextApproval = await policy.createAutoChatApproval(nextCandidate)
  await policy.approve({ id: nextApproval.id, actor: { client: 'ggr-cli', version: 'test' } })
  await policy.consumeGrant({ grant: nextApproval.grantForWorker, ...nextCandidate })
  await policy.recordChatResult({ ...nextCandidate, outcome: 'UNKNOWN' })
  const companyLimitApproval = await policy.createAutoChatApproval({ ...candidate, jobId: 'job-three' })
  await policy.approve({ id: companyLimitApproval.id, actor: { client: 'ggr-cli', version: 'test' } })
  await assert.rejects(
    policy.consumeGrant({ grant: companyLimitApproval.grantForWorker, ...candidate, jobId: 'job-three' }),
    (error) => error.code === 'COMPANY_COOLDOWN_ACTIVE'
  )
  const hourlyLimitCandidate = { ...candidate, jobId: 'job-four', companyName: 'Gamma Corp' }
  const hourlyLimitApproval = await policy.createAutoChatApproval(hourlyLimitCandidate)
  await policy.approve({ id: hourlyLimitApproval.id, actor: { client: 'ggr-cli', version: 'test' } })
  await assert.rejects(
    policy.consumeGrant({ grant: hourlyLimitApproval.grantForWorker, ...hourlyLimitCandidate }),
    (error) => error.code === 'CHAT_HOURLY_QUOTA_EXCEEDED'
  )
  advance(3_600_001)
  const thirdCandidate = { ...candidate, jobId: 'job-five', companyName: 'Delta Corp' }
  const thirdApproval = await policy.createAutoChatApproval(thirdCandidate)
  await policy.approve({ id: thirdApproval.id, actor: { client: 'ggr-cli', version: 'test' } })
  await policy.consumeGrant({ grant: thirdApproval.grantForWorker, ...thirdCandidate })
  await policy.recordChatResult({ ...thirdCandidate, outcome: 'UNKNOWN' })
  const dailyLimitCandidate = { ...candidate, jobId: 'job-six', companyName: 'Epsilon Corp' }
  const dailyLimitApproval = await policy.createAutoChatApproval(dailyLimitCandidate)
  await policy.approve({ id: dailyLimitApproval.id, actor: { client: 'ggr-cli', version: 'test' } })
  await assert.rejects(
    policy.consumeGrant({ grant: dailyLimitApproval.grantForWorker, ...dailyLimitCandidate }),
    (error) => error.code === 'CHAT_DAILY_QUOTA_EXCEEDED'
  )

  await policy.detectRisk({ statusCode: 403, reason: 'Forbidden' })
  assert.equal((await policy.status()).status, 'PAUSED_RISK')
  await assert.rejects(policy.preflightStart({ runRecordId: 100 }), (error) => error.code === 'RISK_COOLDOWN_ACTIVE')
  await assert.rejects(policy.consumeGrant({ grant: 'bad', ...candidate }), (error) => error.code === 'PAUSED_RISK')
  advance(30_001)
  await policy.resume()
  assert.equal((await policy.status()).status, 'IDLE')

  const healthChecked = []
  const invalidLoginPolicy = createSafetyPolicyService({
    store,
    emit: () => {},
    accountHealthCheck: async () => { healthChecked.push(true); return false },
    now: () => currentTime,
    randomBytes: (size) => Buffer.alloc(size, 9)
  })
  await invalidLoginPolicy.detectRisk({ code: 'INVALID_LOGIN', reason: 'login expired' })
  assert.equal((await invalidLoginPolicy.status()).status, 'PAUSED_INVALID_LOGIN')
  await assert.rejects(invalidLoginPolicy.preflightStart({ runRecordId: 101 }), (error) => error.code === 'INVALID_LOGIN_PAUSED')
  await assert.rejects(invalidLoginPolicy.resume(), (error) => error.code === 'ACCOUNT_HEALTH_CHECK_FAILED')
  assert.equal(healthChecked.length, 1)

  assert(emitted.some((event) => event.type === 'approval.required'))
  assert(emitted.some((event) => event.type === 'approval.approved'))
  assert(emitted.some((event) => event.type === 'quota.blocked'))
  assert(emitted.some((event) => event.type === 'risk.detected'))
  assert(emitted.some((event) => event.type === 'risk.cleared'))
  assert(emitted.some((event) => event.type === 'agent.state_changed'))

  await policy.expireRun({ runRecordId: candidate.runRecordId })
  await policy.stopForQuota({ reason: 'manual quota stop' })
} finally {
  await store.close()
  await database.destroy()
  await fs.rm(tempHome, { recursive: true, force: true })
}

console.log('ggr safety policy service check passed')
