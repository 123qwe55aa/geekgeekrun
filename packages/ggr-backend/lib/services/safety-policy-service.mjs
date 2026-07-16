import { createHash, randomBytes as nodeRandomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const AUTO_CHAT_SCOPE = 'auto-chat'

export const DEFAULT_SAFETY_CONFIG = Object.freeze({
  timezone: 'Asia/Shanghai',
  browsePerDay: 100,
  chatPerHour: 5,
  chatPerDay: 20,
  companyCooldownMs: 86_400_000,
  riskCooldownMs: 43_200_000,
  approvalTtlMs: 600_000
})

const APPROVAL_KIND = 'AUTO_CHAT'
const CHAT_RESERVATION = 'CHAT_RESERVED'

function failure(code, message, data = {}) {
  return Object.assign(new Error(message), { code, data })
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('now must return a valid date')
  return date
}

function dayKey(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const value = Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]))
  return `${value.year}-${value.month}-${value.day}`
}

function validateConfig(config) {
  const next = { ...DEFAULT_SAFETY_CONFIG, ...config }
  if (typeof next.timezone !== 'string' || !next.timezone) throw failure('INVALID_SAFETY_CONFIG', 'timezone must be a non-empty IANA timezone')
  try { dayKey(new Date(0), next.timezone) } catch { throw failure('INVALID_SAFETY_CONFIG', 'timezone must be a valid IANA timezone') }
  for (const name of ['browsePerDay', 'chatPerHour', 'chatPerDay', 'companyCooldownMs', 'riskCooldownMs', 'approvalTtlMs']) {
    if (!Number.isFinite(next[name]) || next[name] <= 0) throw failure('INVALID_SAFETY_CONFIG', `${name} must be greater than zero`)
  }
  return Object.freeze(next)
}

function normalizeCandidate(candidate = {}) {
  const required = ['jobId', 'bossId', 'workerId', 'runRecordId']
  for (const key of required) {
    if (candidate[key] === undefined || candidate[key] === null || candidate[key] === '') {
      throw failure('INVALID_AUTO_CHAT_CONTEXT', `${key} is required`)
    }
  }
  if (candidate.companyId === undefined && (!candidate.companyName || typeof candidate.companyName !== 'string')) {
    throw failure('INVALID_AUTO_CHAT_CONTEXT', 'companyId or companyName is required')
  }
  const context = Object.freeze({
    jobId: String(candidate.jobId),
    companyId: candidate.companyId === undefined ? hash(candidate.companyName) : String(candidate.companyId),
    bossId: String(candidate.bossId),
    workerId: String(candidate.workerId),
    runRecordId: String(candidate.runRecordId)
  })
  return Object.freeze({ context, contextHash: hash(stableJson(context)) })
}

function normalizeState(record) {
  if (!record?.state || typeof record.state !== 'object') {
    return { scopeKey: AUTO_CHAT_SCOPE, status: 'IDLE', pausedUntil: null, reason: null, runRecordId: null }
  }
  const state = record.state
  return {
    scopeKey: AUTO_CHAT_SCOPE,
    status: state.status ?? 'IDLE',
    pausedUntil: state.pausedUntil ?? null,
    reason: state.reason ?? null,
    runRecordId: state.runRecordId ?? null
  }
}

function grantIdFrom(grant) {
  const separator = typeof grant === 'string' ? grant.indexOf('.') : -1
  return separator > 0 ? grant.slice(0, separator) : null
}

export function createSafetyPolicyService({
  store,
  emit = () => {},
  accountHealthCheck = async () => true,
  now = () => new Date(),
  randomBytes = nodeRandomBytes,
  config = {}
} = {}) {
  if (!store || typeof store.transaction !== 'function' || typeof store.readState !== 'function') {
    throw new TypeError('store with transaction and readState is required')
  }
  if (typeof emit !== 'function') throw new TypeError('emit must be a function')
  if (typeof accountHealthCheck !== 'function') throw new TypeError('accountHealthCheck must be a function')
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new TypeError('now and randomBytes must be functions')

  let safetyConfig = validateConfig(config)
  let grantSequence = 0
  const pendingWorkerGrants = new Map()

  const timestamp = () => asDate(now())
  const emitAfterCommit = (events) => events.forEach(({ type, payload }) => emit(type, payload))
  const stateEvent = (state) => ({ type: 'agent.state_changed', payload: state })

  async function writeState(tx, next, at) {
    await tx.upsertState({ scopeKey: AUTO_CHAT_SCOPE, state: next, updatedAt: at })
    return stateEvent(next)
  }

  async function status() {
    return normalizeState(await store.readState(AUTO_CHAT_SCOPE))
  }

  function getConfig() {
    return { ...safetyConfig }
  }

  function updateConfig(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw failure('INVALID_SAFETY_CONFIG', 'config patch must be an object')
    safetyConfig = validateConfig({ ...safetyConfig, ...patch })
    return getConfig()
  }

  async function preflightStart({ runRecordId } = {}) {
    if (runRecordId === undefined || runRecordId === null || runRecordId === '') throw failure('INVALID_RUN_CONTEXT', 'runRecordId is required')
    const at = timestamp()
    const result = await store.transaction(async (tx) => {
      const current = normalizeState(await tx.readState(AUTO_CHAT_SCOPE))
      if (current.status === 'PAUSED_INVALID_LOGIN') throw failure('INVALID_LOGIN_PAUSED', 'auto-chat is paused until login health is restored')
      if (current.status === 'PAUSED_RISK' && current.pausedUntil && new Date(current.pausedUntil) > at) {
        throw failure('RISK_COOLDOWN_ACTIVE', 'auto-chat risk cooldown is active', { pausedUntil: current.pausedUntil })
      }
      const events = []
      if (current.status === 'PAUSED_RISK') events.push({ type: 'risk.cleared', payload: { reason: 'cooldown elapsed' } })
      const next = { scopeKey: AUTO_CHAT_SCOPE, status: 'RUNNING', pausedUntil: null, reason: null, runRecordId: String(runRecordId) }
      events.push(await writeState(tx, next, at))
      return { state: next, events }
    })
    emitAfterCommit(result.events)
    return result.state
  }

  async function resume() {
    const at = timestamp()
    let healthy = false
    try {
      const health = await accountHealthCheck()
      healthy = health === true || health?.healthy === true
    } catch {}
    const result = await store.transaction(async (tx) => {
      const current = normalizeState(await tx.readState(AUTO_CHAT_SCOPE))
      const events = []
      if (!healthy) {
        const next = { ...current, status: 'PAUSED_INVALID_LOGIN', pausedUntil: null, reason: 'account health check failed', runRecordId: null }
        events.push(await writeState(tx, next, at))
        return { error: failure('ACCOUNT_HEALTH_CHECK_FAILED', 'account health check failed'), events }
      }
      if (current.status === 'PAUSED_RISK' && current.pausedUntil && new Date(current.pausedUntil) > at) {
        return { error: failure('RISK_COOLDOWN_ACTIVE', 'auto-chat risk cooldown is active', { pausedUntil: current.pausedUntil }), events }
      }
      const next = { scopeKey: AUTO_CHAT_SCOPE, status: 'IDLE', pausedUntil: null, reason: null, runRecordId: null }
      if (current.status !== 'IDLE') {
        events.push({ type: 'risk.cleared', payload: { reason: 'manual resume' } })
        events.push(await writeState(tx, next, at))
      }
      return { state: next, events }
    })
    emitAfterCommit(result.events)
    if (result.error) throw result.error
    return result.state
  }

  async function recordBrowse({ runRecordId, jobId = null } = {}) {
    const at = timestamp()
    const today = dayKey(at, safetyConfig.timezone)
    const result = await store.transaction(async (tx) => {
      const ledger = await tx.listLedger({ scopeKey: AUTO_CHAT_SCOPE, actionType: 'BROWSE' })
      const used = ledger.filter((entry) => entry.details.dayKey === today && entry.status === 'RECORDED').length
      if (used >= safetyConfig.browsePerDay) {
        await tx.insertLedger({ scopeKey: AUTO_CHAT_SCOPE, actionType: 'BROWSE', actionKey: jobId == null ? null : String(jobId), status: 'BLOCKED', details: { dayKey: today, reason: 'BROWSE_DAILY_QUOTA_EXCEEDED' }, createdAt: at })
        return { error: failure('BROWSE_DAILY_QUOTA_EXCEEDED', 'daily browse quota exceeded', { limit: safetyConfig.browsePerDay }), events: [{ type: 'quota.blocked', payload: { quota: 'browsePerDay', limit: safetyConfig.browsePerDay } }] }
      }
      const entry = await tx.insertLedger({ scopeKey: AUTO_CHAT_SCOPE, actionType: 'BROWSE', actionKey: jobId == null ? null : String(jobId), status: 'RECORDED', details: { dayKey: today, runRecordId: runRecordId == null ? null : String(runRecordId) }, createdAt: at })
      return { entry, events: [] }
    })
    emitAfterCommit(result.events)
    if (result.error) throw result.error
    return result.entry
  }

  async function createAutoChatApproval(candidate) {
    const { context, contextHash } = normalizeCandidate(candidate)
    const at = timestamp()
    const id = randomUUID()
    const grant = `${id}.${Buffer.from(randomBytes(32)).toString('base64url')}.${++grantSequence}`
    const expiresAt = new Date(at.getTime() + safetyConfig.approvalTtlMs)
    let approval
    try {
      approval = await store.transaction((tx) => tx.insertApproval({ id, kind: APPROVAL_KIND, status: 'PENDING', context, contextHash, requestedBy: context.workerId, expiresAt, grantHash: hash(grant), createdAt: at, updatedAt: at }))
    } catch (error) {
      if (/UNIQUE constraint failed/.test(error?.message)) throw failure('APPROVAL_ALREADY_PENDING', 'an approval is already pending for this candidate', { contextHash })
      throw error
    }
    pendingWorkerGrants.set(id, grant)
    emitAfterCommit([{ type: 'approval.required', payload: { id: approval.id, context: approval.context, expiresAt: approval.expiresAt } }])
    return { id: approval.id, expiresAt: approval.expiresAt, context: approval.context, grantForWorker: grant }
  }

  async function approve({ id, actor = {} } = {}) {
    if (!id) throw failure('INVALID_APPROVAL_ID', 'approval id is required')
    const at = timestamp()
    const result = await store.transaction(async (tx) => {
      const approval = await tx.getApproval(id)
      if (!approval) throw failure('APPROVAL_NOT_FOUND', 'approval was not found')
      if (new Date(approval.expiresAt) <= at) {
        if (approval.status === 'PENDING') await tx.updateApprovalIfStatus(id, 'PENDING', { status: 'EXPIRED', updatedAt: at })
        return { error: failure('APPROVAL_EXPIRED', 'approval has expired'), events: [] }
      }
      if (approval.status !== 'PENDING') throw failure(`APPROVAL_${approval.status}`, `approval is ${approval.status.toLowerCase()}`)
      const updated = await tx.updateApprovalIfStatus(id, 'PENDING', { status: 'APPROVED', reviewerId: JSON.stringify(actor), reviewedAt: at, updatedAt: at })
      if (!updated) throw failure('APPROVAL_ALREADY_REVIEWED', 'approval was already reviewed')
      return { approval: updated, events: [{ type: 'approval.approved', payload: { id, actor } }] }
    })
    emitAfterCommit(result.events)
    if (result.error) throw result.error
    return result.approval
  }

  async function reject({ id, actor = {}, reason = null } = {}) {
    if (!id) throw failure('INVALID_APPROVAL_ID', 'approval id is required')
    const at = timestamp()
    const result = await store.transaction(async (tx) => {
      const approval = await tx.getApproval(id)
      if (!approval) throw failure('APPROVAL_NOT_FOUND', 'approval was not found')
      if (new Date(approval.expiresAt) <= at) {
        if (approval.status === 'PENDING') await tx.updateApprovalIfStatus(id, 'PENDING', { status: 'EXPIRED', updatedAt: at })
        return { error: failure('APPROVAL_EXPIRED', 'approval has expired'), events: [] }
      }
      if (approval.status !== 'PENDING') throw failure(`APPROVAL_${approval.status}`, `approval is ${approval.status.toLowerCase()}`)
      const updated = await tx.updateApprovalIfStatus(id, 'PENDING', { status: 'REJECTED', reviewerId: JSON.stringify(actor), reviewerNote: reason, reviewedAt: at, updatedAt: at })
      if (!updated) throw failure('APPROVAL_ALREADY_REVIEWED', 'approval was already reviewed')
      pendingWorkerGrants.delete(id)
      return { approval: updated, events: [] }
    })
    emitAfterCommit(result.events)
    if (result.error) throw result.error
    return result.approval
  }

  async function consumeGrant({ grant, ...candidate } = {}) {
    const id = grantIdFrom(grant)
    const { context, contextHash } = normalizeCandidate(candidate)
    const at = timestamp()
    const result = await store.transaction(async (tx) => {
      const current = normalizeState(await tx.readState(AUTO_CHAT_SCOPE))
      if (current.status === 'PAUSED_RISK') throw failure('PAUSED_RISK', 'auto-chat is paused for risk')
      if (current.status === 'PAUSED_INVALID_LOGIN') throw failure('INVALID_LOGIN_PAUSED', 'auto-chat is paused until login health is restored')
      if (!id) throw failure('INVALID_APPROVAL_GRANT', 'grant is invalid')
      const approval = await tx.getApproval(id)
      if (!approval) throw failure('APPROVAL_NOT_FOUND', 'approval was not found')
      if (approval.status === 'CONSUMED') throw failure('APPROVAL_ALREADY_CONSUMED', 'approval grant was already consumed')
      if (new Date(approval.expiresAt) <= at) {
        if (approval.status === 'PENDING' || approval.status === 'APPROVED') await tx.updateApproval(id, { status: 'EXPIRED', updatedAt: at })
        pendingWorkerGrants.delete(id)
        throw failure('APPROVAL_EXPIRED', 'approval has expired')
      }
      if (approval.status !== 'APPROVED') throw failure(`APPROVAL_${approval.status}`, `approval is ${approval.status.toLowerCase()}`)
      if (!safeEqual(approval.grantHash ?? '', hash(grant))) throw failure('INVALID_APPROVAL_GRANT', 'grant is invalid')
      if (approval.contextHash !== contextHash || stableJson(approval.context) !== stableJson(context)) throw failure('APPROVAL_CONTEXT_MISMATCH', 'grant does not match this auto-chat context')
      const cooldown = await tx.getCompanyCooldown(context.companyId)
      if (cooldown && new Date(cooldown.expiresAt) > at) {
        await tx.insertLedger({ scopeKey: AUTO_CHAT_SCOPE, actionType: 'AUTO_CHAT', actionKey: contextHash, status: 'BLOCKED', details: { reason: 'COMPANY_COOLDOWN_ACTIVE', companyId: context.companyId }, createdAt: at })
        return { error: failure('COMPANY_COOLDOWN_ACTIVE', 'company cooldown is active', { expiresAt: cooldown.expiresAt }), events: [{ type: 'quota.blocked', payload: { quota: 'companyCooldown', companyId: context.companyId, expiresAt: cooldown.expiresAt } }] }
      }
      const reservations = (await tx.listLedger({ scopeKey: AUTO_CHAT_SCOPE, actionType: 'AUTO_CHAT', status: CHAT_RESERVATION }))
      const hourly = reservations.filter((entry) => new Date(entry.createdAt).getTime() > at.getTime() - 3_600_000)
      const daily = reservations.filter((entry) => entry.details.dayKey === dayKey(at, safetyConfig.timezone))
      const exceeded = hourly.length >= safetyConfig.chatPerHour
        ? ['CHAT_HOURLY_QUOTA_EXCEEDED', 'chatPerHour', safetyConfig.chatPerHour]
        : daily.length >= safetyConfig.chatPerDay
          ? ['CHAT_DAILY_QUOTA_EXCEEDED', 'chatPerDay', safetyConfig.chatPerDay]
          : null
      if (exceeded) {
        const [code, quota, limit] = exceeded
        await tx.insertLedger({ scopeKey: AUTO_CHAT_SCOPE, actionType: 'AUTO_CHAT', actionKey: contextHash, status: 'BLOCKED', details: { reason: code, dayKey: dayKey(at, safetyConfig.timezone) }, createdAt: at })
        return { error: failure(code, 'auto-chat quota exceeded', { quota, limit }), events: [{ type: 'quota.blocked', payload: { quota, limit } }] }
      }
      const consumed = await tx.updateApprovalIfStatus(id, 'APPROVED', { status: 'CONSUMED', updatedAt: at })
      if (!consumed) throw failure('APPROVAL_ALREADY_CONSUMED', 'approval grant was already consumed')
      const reservation = await tx.insertLedger({ scopeKey: AUTO_CHAT_SCOPE, actionType: 'AUTO_CHAT', actionKey: contextHash, status: CHAT_RESERVATION, details: { ...context, dayKey: dayKey(at, safetyConfig.timezone), approvalId: id }, createdAt: at })
      await tx.setCompanyCooldown({ companyKey: context.companyId, reason: 'auto-chat reserved', expiresAt: new Date(at.getTime() + safetyConfig.companyCooldownMs), createdAt: at, updatedAt: at })
      pendingWorkerGrants.delete(id)
      return { reservation, events: [] }
    })
    emitAfterCommit(result.events)
    if (result.error) throw result.error
    return result.reservation
  }

  async function recordChatResult(candidate = {}) {
    const { context, contextHash } = normalizeCandidate(candidate)
    const at = timestamp()
    const outcome = candidate.outcome === undefined ? 'UNKNOWN' : String(candidate.outcome)
    return store.transaction(async (tx) => {
      const reservations = await tx.listLedger({ scopeKey: AUTO_CHAT_SCOPE, actionType: 'AUTO_CHAT', status: CHAT_RESERVATION })
      if (!reservations.some((entry) => entry.actionKey === contextHash)) throw failure('CHAT_NOT_RESERVED', 'chat result has no consumed approval grant')
      return tx.insertLedger({ scopeKey: AUTO_CHAT_SCOPE, actionType: 'AUTO_CHAT_RESULT', actionKey: contextHash, status: outcome, details: { ...context, outcome }, createdAt: at })
    })
  }

  async function detectRisk({ statusCode, code, reason = null } = {}) {
    const at = timestamp()
    const invalidLogin = code === 'INVALID_LOGIN' || statusCode === 401
    const next = invalidLogin
      ? { scopeKey: AUTO_CHAT_SCOPE, status: 'PAUSED_INVALID_LOGIN', pausedUntil: null, reason: reason ?? code, runRecordId: null }
      : { scopeKey: AUTO_CHAT_SCOPE, status: 'PAUSED_RISK', pausedUntil: new Date(at.getTime() + safetyConfig.riskCooldownMs).toISOString(), reason: reason ?? code ?? `HTTP ${statusCode ?? 'risk'}`, runRecordId: null }
    const result = await store.transaction(async (tx) => {
      await tx.insertEvent({ scopeKey: AUTO_CHAT_SCOPE, type: 'risk.detected', payload: { statusCode: statusCode ?? null, code: code ?? null, reason: next.reason }, createdAt: at })
      return { state: next, events: [{ type: 'risk.detected', payload: { statusCode: statusCode ?? null, code: code ?? null, reason: next.reason } }, await writeState(tx, next, at)] }
    })
    emitAfterCommit(result.events)
    return result.state
  }

  async function expireRun({ runRecordId } = {}) {
    const at = timestamp()
    const result = await store.transaction(async (tx) => {
      const current = normalizeState(await tx.readState(AUTO_CHAT_SCOPE))
      if (current.status !== 'RUNNING' || (runRecordId !== undefined && String(runRecordId) !== current.runRecordId)) return { state: current, events: [] }
      const next = { scopeKey: AUTO_CHAT_SCOPE, status: 'IDLE', pausedUntil: null, reason: null, runRecordId: null }
      return { state: next, events: [await writeState(tx, next, at)] }
    })
    emitAfterCommit(result.events)
    return result.state
  }

  async function stopForQuota({ reason = 'quota exceeded' } = {}) {
    const at = timestamp()
    const result = await store.transaction(async (tx) => {
      const next = { scopeKey: AUTO_CHAT_SCOPE, status: 'PAUSED_QUOTA', pausedUntil: null, reason: String(reason), runRecordId: null }
      await tx.insertEvent({ scopeKey: AUTO_CHAT_SCOPE, type: 'quota.blocked', payload: { reason: next.reason }, createdAt: at })
      return { state: next, events: [{ type: 'quota.blocked', payload: { reason: next.reason } }, await writeState(tx, next, at)] }
    })
    emitAfterCommit(result.events)
    return result.state
  }

  return Object.freeze({ status, getConfig, updateConfig, preflightStart, resume, recordBrowse, createAutoChatApproval, approve, reject, consumeGrant, recordChatResult, detectRisk, expireRun, stopForQuota })
}
