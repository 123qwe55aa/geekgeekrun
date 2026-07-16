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
  await assert.rejects(policy.approve({ id: expired.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0' } }), (error) => error.code === 'APPROVAL_EXPIRED')
  await assert.rejects(
    policy.consumeGrant({ grant: expired.grantForWorker, ...candidate }),
    (error) => error.code === 'APPROVAL_EXPIRED'
  )

  const approval = await policy.createAutoChatApproval(candidate)
  await policy.approve({ id: approval.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0' } })
  await assert.rejects(
    policy.consumeGrant({ grant: approval.grantForWorker, ...candidate, runRecordId: 100 }),
    (error) => error.code === 'RUN_RECORD_MISMATCH'
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
  await policy.approve({ id: nextApproval.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0' } })
  await policy.consumeGrant({ grant: nextApproval.grantForWorker, ...nextCandidate })
  await policy.recordChatResult({ ...nextCandidate, outcome: 'UNKNOWN' })
  const companyLimitApproval = await policy.createAutoChatApproval({ ...candidate, jobId: 'job-three' })
  await policy.approve({ id: companyLimitApproval.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0' } })
  await assert.rejects(
    policy.consumeGrant({ grant: companyLimitApproval.grantForWorker, ...candidate, jobId: 'job-three' }),
    (error) => error.code === 'COMPANY_COOLDOWN_ACTIVE'
  )
  const hourlyLimitCandidate = { ...candidate, jobId: 'job-four', companyName: 'Gamma Corp' }
  const hourlyLimitApproval = await policy.createAutoChatApproval(hourlyLimitCandidate)
  await policy.approve({ id: hourlyLimitApproval.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0' } })
  await assert.rejects(
    policy.consumeGrant({ grant: hourlyLimitApproval.grantForWorker, ...hourlyLimitCandidate }),
    (error) => error.code === 'CHAT_HOURLY_QUOTA_EXCEEDED'
  )
  advance(3_600_001)
  const thirdCandidate = { ...candidate, jobId: 'job-five', companyName: 'Delta Corp' }
  const thirdApproval = await policy.createAutoChatApproval(thirdCandidate)
  await policy.approve({ id: thirdApproval.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0' } })
  await policy.consumeGrant({ grant: thirdApproval.grantForWorker, ...thirdCandidate })
  await policy.recordChatResult({ ...thirdCandidate, outcome: 'UNKNOWN' })
  const dailyLimitCandidate = { ...candidate, jobId: 'job-six', companyName: 'Epsilon Corp' }
  const dailyLimitApproval = await policy.createAutoChatApproval(dailyLimitCandidate)
  await policy.approve({ id: dailyLimitApproval.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0' } })
  await assert.rejects(
    policy.consumeGrant({ grant: dailyLimitApproval.grantForWorker, ...dailyLimitCandidate }),
    (error) => error.code === 'CHAT_DAILY_QUOTA_EXCEEDED'
  )

  await policy.detectRisk({ statusCode: 403, reason: 'Forbidden' })
  assert.equal((await policy.status()).status, 'PAUSED_RISK')
  await assert.rejects(policy.preflightStart({ runRecordId: 100 }), (error) => error.code === 'RISK_COOLDOWN_ACTIVE')
  await assert.rejects(policy.consumeGrant({ grant: 'bad', ...candidate }), (error) => error.code === 'PAUSED_RISK')
  const failedRiskResumePolicy = createSafetyPolicyService({
    store,
    emit: (type, payload) => emitted.push({ type, payload }),
    accountHealthCheck: async () => false,
    now: () => currentTime,
    randomBytes: (size) => Buffer.alloc(size, 5)
  })
  const activeRiskPause = await policy.status()
  await assert.rejects(failedRiskResumePolicy.resume(), (error) => error.code === 'ACCOUNT_HEALTH_CHECK_FAILED')
  assert.deepEqual(await policy.status(), activeRiskPause, 'failed health checks must preserve an active risk pause and deadline')
  await assert.rejects(policy.resume(), (error) => error.code === 'RISK_COOLDOWN_ACTIVE')
  const resumeHealthFailure = emitted.findLast((event) => event.type === 'resume.health_check_failed')
  assert.equal(resumeHealthFailure.payload.pausedUntil, activeRiskPause.pausedUntil)
  advance(30_001)
  const pausedRisk = await policy.status()
  await assert.rejects(policy.preflightStart({ runRecordId: candidate.runRecordId }), (error) => error.code === 'PAUSED_RISK')
  assert.deepEqual(await policy.status(), pausedRisk, 'preflight start must not clear an elapsed risk pause')
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

  // A policy without an injected account-health adapter must fail closed.  A
  // finished risk cooldown is not itself authorization to start another run.
  await policy.detectRisk({ statusCode: 403, reason: 'Forbidden again' })
  advance(30_001)
  const defaultHealthPolicy = createSafetyPolicyService({ store, emit: () => {}, now: () => currentTime, randomBytes: (size) => Buffer.alloc(size, 3) })
  await assert.rejects(defaultHealthPolicy.resume(), (error) => error.code === 'ACCOUNT_HEALTH_CHECK_FAILED')
  await policy.resume()

  // A grant is valid only within the exact durable run for which it was
  // approved; pending/approved grants cannot authorize an idle or replaced run.
  await policy.updateConfig({ chatPerHour: 10, chatPerDay: 10 })
  const idleGrant = await policy.createAutoChatApproval({ ...candidate, jobId: 'job-idle-grant' })
  await policy.approve({ id: idleGrant.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0' } })
  await assert.rejects(
    policy.consumeGrant({ grant: idleGrant.grantForWorker, ...candidate, jobId: 'job-idle-grant' }),
    (error) => error.code === 'RUN_NOT_ACTIVE'
  )
  await policy.stopForQuota({ reason: 'test quota pause' })
  await assert.rejects(
    policy.consumeGrant({ grant: idleGrant.grantForWorker, ...candidate, jobId: 'job-idle-grant' }),
    (error) => error.code === 'RUN_NOT_ACTIVE'
  )
  await policy.preflightStart({ runRecordId: candidate.runRecordId })
  const stoppedRunGrant = await policy.createAutoChatApproval({ ...candidate, jobId: 'job-stopped-run' })
  await policy.approve({ id: stoppedRunGrant.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0' } })
  await policy.expireRun({ runRecordId: candidate.runRecordId })
  await assert.rejects(
    policy.consumeGrant({ grant: stoppedRunGrant.grantForWorker, ...candidate, jobId: 'job-stopped-run' }),
    (error) => error.code === 'RUN_NOT_ACTIVE'
  )
  await policy.preflightStart({ runRecordId: candidate.runRecordId })
  const replacedRunGrant = await policy.createAutoChatApproval({ ...candidate, jobId: 'job-replaced-run' })
  await policy.approve({ id: replacedRunGrant.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0' } })
  await policy.preflightStart({ runRecordId: 'replacement-run' })
  await assert.rejects(
    policy.consumeGrant({ grant: replacedRunGrant.grantForWorker, ...candidate, jobId: 'job-replaced-run' }),
    (error) => error.code === 'RUN_RECORD_MISMATCH'
  )

  // The approval boundary takes only the trusted handshake identity shape.
  const actorSecret = 'actor-api-key-never-persisted'
  const untrustedActorApproval = await policy.createAutoChatApproval({ ...candidate, jobId: 'job-untrusted-actor', runRecordId: 'replacement-run' })
  await assert.rejects(
    policy.approve({ id: untrustedActorApproval.id, actor: { client: 'ggr-cli', clientVersion: '0.0.0', apiKey: actorSecret } }),
    (error) => error.code === 'INVALID_APPROVAL_ACTOR'
  )
  await assert.rejects(
    policy.approve({ id: untrustedActorApproval.id, actor: { client: 'untrusted-client', clientVersion: '0.0.0' } }),
    (error) => error.code === 'INVALID_APPROVAL_ACTOR'
  )
  await assert.rejects(
    policy.approve({ id: untrustedActorApproval.id, actor: { client: 'ggr-cli', version: '0.0.0' } }),
    (error) => error.code === 'INVALID_APPROVAL_ACTOR'
  )
  const normalizedActorApproval = await policy.createAutoChatApproval({ ...candidate, jobId: 'job-normalized-actor', runRecordId: 'replacement-run' })
  const normalizedActor = { client: 'electron', clientVersion: '1.2.3' }
  await assert.rejects(
    policy.approve({ id: normalizedActorApproval.id, actor: { ...normalizedActor, token: actorSecret } }),
    (error) => error.code === 'INVALID_APPROVAL_ACTOR'
  )
  const approvedByNormalizedActor = await policy.approve({ id: normalizedActorApproval.id, actor: normalizedActor })
  assert.equal(approvedByNormalizedActor.reviewerId, 'electron@1.2.3')
  const versionSecret = 'token=secret'
  const invalidVersionApproval = await policy.createAutoChatApproval({ ...candidate, jobId: 'job-invalid-version', runRecordId: 'replacement-run' })
  await assert.rejects(
    policy.approve({ id: invalidVersionApproval.id, actor: { client: 'ggr-mcp', clientVersion: versionSecret } }),
    (error) => error.code === 'INVALID_APPROVAL_ACTOR'
  )
  const mcpVersionApproval = await policy.createAutoChatApproval({ ...candidate, jobId: 'job-mcp-version', runRecordId: 'replacement-run' })
  const mcpApproval = await policy.approve({ id: mcpVersionApproval.id, actor: { client: 'ggr-mcp', clientVersion: '0.1.0' } })
  assert.equal(mcpApproval.reviewerId, 'ggr-mcp@0.1.0')
  const rawApprovalRows = await database.query("SELECT reviewer_id FROM ggr_approval_request WHERE id = ? OR id = ? OR id = ?", [untrustedActorApproval.id, normalizedActorApproval.id, invalidVersionApproval.id])
  assert(!JSON.stringify(rawApprovalRows).includes(actorSecret), 'actor secrets must not survive approval rows')
  assert(!JSON.stringify(rawApprovalRows).includes(versionSecret), 'invalid client versions must not survive approval rows')
  assert(!JSON.stringify(emitted).includes(actorSecret), 'actor secrets must not survive emitted event data')
  assert(!JSON.stringify(emitted).includes(versionSecret), 'invalid client versions must not survive emitted event data')
  const approvalEvent = emitted.findLast((event) => event.type === 'approval.approved' && event.payload.id === normalizedActorApproval.id)
  assert.deepEqual(approvalEvent.payload.actor, normalizedActor)

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
