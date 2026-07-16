import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacyApprovalQueue } from './migration-service.mjs'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 30000
const LOCK_RETRY_MS = 25
const AUTO_REPLY_KIND = 'AUTO_REPLY'
const LEGACY_MIGRATION_KIND = 'MIGRATION'
const LEGACY_APPROVAL_EXPIRY = new Date('9999-12-31T23:59:59.999Z')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function approvalDedupeKey(request) {
  return createHash('sha256').update([
    request.hrName ?? '',
    request.company ?? '',
    request.jobTitle ?? '',
    request.latestHrMessage ?? ''
  ].join('\n')).digest('hex')
}

function autoReplyContext(request) {
  return {
    hrName: request.hrName ?? '',
    company: request.company ?? '',
    jobTitle: request.jobTitle ?? '',
    latestHrMessage: request.latestHrMessage ?? '',
    detectedIntent: request.detectedIntent ?? 'UNKNOWN',
    draftReply: request.draftReply ?? '',
    draftSource: request.draftSource ?? (request.draftReply ? 'model_review_draft' : 'none'),
    draftSafety: request.draftSafety ?? 'needs_human_review',
    reason: request.reason ?? '',
    dedupeKey: request.dedupeKey ?? approvalDedupeKey(request),
    ...(request.sentAt === undefined ? {} : { sentAt: request.sentAt })
  }
}

function autoReplyContextHash(request) {
  return createHash('sha256').update(`AUTO_REPLY\n${autoReplyContext(request).dedupeKey}`).digest('hex')
}

function toStoreStatus(status = 'pending') {
  return ({
    pending: 'PENDING',
    approved_auto_reply: 'APPROVED',
    human_required: 'REJECTED',
    auto_reply_sent: 'SENT',
    auto_reply_failed: 'FAILED',
    auto_reply_expired: 'EXPIRED'
  })[status] ?? `LEGACY_${String(status).toUpperCase()}`
}

function toLegacyStatus(status) {
  return ({
    PENDING: 'pending',
    APPROVED: 'approved_auto_reply',
    REJECTED: 'human_required',
    SENT: 'auto_reply_sent',
    FAILED: 'auto_reply_failed',
    EXPIRED: 'auto_reply_expired'
  })[status] ?? String(status).replace(/^LEGACY_/, '').toLowerCase()
}

function fromStoreApproval(approval) {
  return {
    ...approval.context,
    id: approval.id,
    createdAt: approval.createdAt,
    status: toLegacyStatus(approval.status),
    ...(approval.reviewedAt == null ? {} : { reviewedAt: approval.reviewedAt }),
    ...(approval.reviewerNote == null ? {} : { reviewReason: approval.reviewerNote })
  }
}

function toStoreApproval(request, clock) {
  const createdAt = request.createdAt ?? clock().toISOString()
  const status = toStoreStatus(request.status)
  return {
    id: request.id ?? randomUUID(),
    kind: AUTO_REPLY_KIND,
    status,
    context: autoReplyContext(request),
    contextHash: autoReplyContextHash(request),
    requestedBy: 'read-no-reply',
    reviewerNote: request.reviewReason ?? null,
    reviewedAt: request.reviewedAt ?? (status === 'PENDING' ? null : createdAt),
    expiresAt: LEGACY_APPROVAL_EXPIRY,
    grantHash: null,
    createdAt,
    updatedAt: request.updatedAt ?? request.reviewedAt ?? createdAt
  }
}

export function defaultApprovalQueueFilePath() {
  return path.join(os.homedir(), '.geekgeekrun', 'storage', 'hr-reply-approval-queue.json')
}

async function backupCorruptFile(filePath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  await fs.rename(filePath, `${filePath}.corrupt-${timestamp}.bak`).catch(() => {})
}

async function readQueueFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    await fs.chmod(filePath, PRIVATE_FILE_MODE)
    return JSON.parse(content)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    if (error instanceof SyntaxError) {
      await backupCorruptFile(filePath)
      return []
    }
    throw error
  }
}

async function writePrivateJson(filePath, value) {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
  await fs.chmod(directory, PRIVATE_DIR_MODE)
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
    await fs.chmod(temporaryPath, PRIVATE_FILE_MODE)
    await fs.rename(temporaryPath, filePath)
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

async function readLockSnapshot(lockPath) {
  let handle
  try {
    handle = await fs.open(lockPath, 'r')
    const [stat, content] = await Promise.all([handle.stat(), handle.readFile('utf8')])
    let state
    try { state = JSON.parse(content) } catch {}
    const valid = state && typeof state.token === 'string' && state.token &&
      Number.isInteger(state.pid) && Number.isFinite(state.leaseAt)
    return {
      state: valid ? state : null,
      malformed: !valid,
      content,
      dev: stat.dev,
      ino: stat.ino,
      leaseAt: valid ? Math.max(state.leaseAt, stat.mtimeMs) : stat.mtimeMs
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

function sameLock(left, right) {
  const leftToken = left?.state?.token ?? left?.token
  const rightToken = right?.state?.token ?? right?.token
  const identityMatches = leftToken || rightToken ? leftToken === rightToken : left?.content === right?.content
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && identityMatches)
}

async function writeCompleteRecord(handle, state) {
  const payload = Buffer.from(JSON.stringify(state))
  let offset = 0
  while (offset < payload.length) {
    const { bytesWritten } = await handle.write(payload, offset, payload.length - offset, offset)
    offset += bytesWritten
  }
  await handle.truncate(payload.length)
  await handle.sync()
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function tryCreateHolder(lockPath) {
  const token = randomUUID()
  const state = { token, pid: process.pid, leaseAt: Date.now() }
  const temporaryPath = `${lockPath}.${token}.tmp`
  let handle
  let holder
  let linked = false
  try {
    handle = await fs.open(temporaryPath, 'wx', PRIVATE_FILE_MODE)
    await writeCompleteRecord(handle, state)
    const stat = await handle.stat()
    holder = { handle, token, pid: process.pid, dev: stat.dev, ino: stat.ino, leaseAt: state.leaseAt }
    await fs.link(temporaryPath, lockPath)
    linked = true
    await fs.unlink(temporaryPath)
    await syncDirectory(path.dirname(lockPath))
    return holder
  } catch (error) {
    if (linked && holder) {
      const pathStat = await fs.lstat(lockPath).catch(() => null)
      if (pathStat?.dev === holder.dev && pathStat?.ino === holder.ino) await fs.unlink(lockPath).catch(() => {})
    }
    await handle?.close().catch(() => {})
    await fs.unlink(temporaryPath).catch(() => {})
    if (error?.code === 'EEXIST') return null
    throw error
  }
}

async function refreshHolder(lockPath, holder) {
  const current = await readLockSnapshot(lockPath)
  if (!sameLock(holder, current)) return false
  const now = new Date()
  await holder.handle.utimes(now, now)
  await holder.handle.sync()
  holder.leaseAt = now.getTime()
  return true
}

async function removeIfOwned(lockPath, holder) {
  const current = await readLockSnapshot(lockPath)
  if (!sameLock(holder, current)) return false
  const pathStat = await fs.lstat(lockPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (!pathStat || pathStat.dev !== holder.dev || pathStat.ino !== holder.ino) return false
  const final = await readLockSnapshot(lockPath)
  if (!sameLock(holder, final)) return false
  await fs.unlink(lockPath).catch((error) => { if (error?.code !== 'ENOENT') throw error })
  return true
}

async function mayRecover(snapshot, { staleMs, isProcessAlive }) {
  if (!snapshot || Date.now() - snapshot.leaseAt <= staleMs) return false
  return snapshot.malformed || !await isProcessAlive(snapshot.state.pid)
}

async function breakExpiredLockWithoutCompetition(lockPath, options) {
  const observed = await readLockSnapshot(lockPath)
  if (!await mayRecover(observed, options)) return false

  const current = await readLockSnapshot(lockPath)
  if (!sameLock(observed, current)) return false
  if (!await mayRecover(current, options)) return false
  const final = await readLockSnapshot(lockPath)
  if (!sameLock(current, final)) return false
  if (!await mayRecover(final, options)) return false
  const pathStat = await fs.lstat(lockPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (!pathStat || pathStat.dev !== final.dev || pathStat.ino !== final.ino) return false
  await fs.unlink(lockPath).catch((error) => { if (error?.code !== 'ENOENT') throw error })
  return true
}

function startHeartbeat(lockPath, holder, heartbeatMs) {
  let operations = Promise.resolve()
  const timer = setInterval(() => {
    operations = operations.then(() => refreshHolder(lockPath, holder)).catch(() => false)
  }, heartbeatMs)
  return async () => {
    clearInterval(timer)
    await operations
  }
}

async function recoveryState(cleanerPath, options) {
  const directory = path.dirname(cleanerPath)
  const basename = path.basename(cleanerPath)
  const legacyPath = `${cleanerPath}.recover`
  const intentPrefix = `${basename}.recover.`
  let blocked = false

  let legacy = await readLockSnapshot(legacyPath)
  if (legacy) {
    if (await mayRecover(legacy, options)) {
      await breakExpiredLockWithoutCompetition(legacyPath, options)
      legacy = await readLockSnapshot(legacyPath)
    }
    if (legacy) blocked = true
  }

  const intents = []
  const entries = await fs.readdir(directory).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))
  for (const entry of entries) {
    if (!entry.startsWith(intentPrefix) || entry.endsWith('.tmp')) continue
    const intentPath = path.join(directory, entry)
    let snapshot = await readLockSnapshot(intentPath)
    if (!snapshot) continue
    if (await mayRecover(snapshot, options)) {
      await breakExpiredLockWithoutCompetition(intentPath, options)
      snapshot = await readLockSnapshot(intentPath)
      if (!snapshot) continue
    }
    if (snapshot.malformed) blocked = true
    else intents.push({ path: intentPath, snapshot })
  }
  intents.sort((left, right) => left.snapshot.state.token.localeCompare(right.snapshot.state.token))
  return { blocked, intents }
}

async function recoverOrphanedCleaner(cleanerPath, options) {
  const observed = await readLockSnapshot(cleanerPath)
  if (!await mayRecover(observed, options)) return false

  const intentPath = `${cleanerPath}.recover.${randomUUID()}`
  const intent = await tryCreateHolder(intentPath)
  if (!intent) return false
  const stopHeartbeat = startHeartbeat(intentPath, intent, options.heartbeatMs)
  try {
    await sleep(0)
    const state = await recoveryState(cleanerPath, options)
    if (state.blocked || state.intents[0]?.snapshot.state.token !== intent.token) return false
    return breakExpiredLockWithoutCompetition(cleanerPath, options)
  } finally {
    await stopHeartbeat()
    await removeIfOwned(intentPath, intent)
    await intent.handle.close().catch(() => {})
  }
}

async function breakExpiredLock(lockPath, options) {
  const cleanerPath = `${lockPath}.clean`
  const cleanerSnapshot = await readLockSnapshot(cleanerPath)
  if (cleanerSnapshot) {
    if (await mayRecover(cleanerSnapshot, options)) await recoverOrphanedCleaner(cleanerPath, options)
    return false
  }

  const pendingRecovery = await recoveryState(cleanerPath, options)
  if (pendingRecovery.blocked || pendingRecovery.intents.length) return false
  const cleaner = await tryCreateHolder(cleanerPath)
  if (!cleaner) return false
  const stopHeartbeat = startHeartbeat(cleanerPath, cleaner, options.heartbeatMs)
  try {
    const recoveryAfterAcquire = await recoveryState(cleanerPath, options)
    if (recoveryAfterAcquire.blocked || recoveryAfterAcquire.intents.length) return false
    return await breakExpiredLockWithoutCompetition(lockPath, options)
  } finally {
    await stopHeartbeat()
    await removeIfOwned(cleanerPath, cleaner)
    await cleaner.handle.close().catch(() => {})
  }
}

async function withQueueLock(queueFilePath, operation, {
  timeoutMs = LOCK_TIMEOUT_MS,
  staleMs = LOCK_STALE_MS,
  retryMs = LOCK_RETRY_MS,
  heartbeatMs = Math.max(1, Math.floor(staleMs / 3)),
  isProcessAlive = processIsAlive
} = {}) {
  const directory = path.dirname(queueFilePath)
  const lockPath = `${queueFilePath}.lock`
  const deadline = Date.now() + timeoutMs
  let holder

  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
  await fs.chmod(directory, PRIVATE_DIR_MODE)
  while (!holder) {
    holder = await tryCreateHolder(lockPath)
    if (holder) break
    if (await breakExpiredLock(lockPath, { staleMs, isProcessAlive, heartbeatMs })) continue
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for approval queue lock: ${queueFilePath}`)
    await sleep(retryMs)
  }

  const stopHeartbeat = startHeartbeat(lockPath, holder, heartbeatMs)
  try {
    return await operation()
  } finally {
    await stopHeartbeat()
    await removeIfOwned(lockPath, holder)
    await holder.handle.close().catch(() => {})
  }
}

export function createApprovalService({
  queueFilePath = defaultApprovalQueueFilePath(),
  safetyStore,
  emit = () => {},
  clock = () => new Date(),
  lockTimeoutMs,
  lockStaleMs,
  lockRetryMs,
  lockHeartbeatMs,
  isProcessAlive
} = {}) {
  const lockOptions = {
    timeoutMs: lockTimeoutMs,
    staleMs: lockStaleMs,
    retryMs: lockRetryMs,
    heartbeatMs: lockHeartbeatMs,
    isProcessAlive
  }
  let migration

  async function ensureMigrated() {
    if (!safetyStore) return
    migration ??= (async () => {
      const markerId = `legacy-auto-reply-queue:${createHash('sha256').update(queueFilePath).digest('hex')}`
      let records
      try {
        const queue = await readQueueFile(queueFilePath)
        if (!queue.length) return
        const pendingContextHashes = new Set()
        records = queue.map((request) => {
          const record = toStoreApproval(request, clock)
          if (record.status === 'PENDING' && pendingContextHashes.has(record.contextHash)) {
            record.contextHash = createHash('sha256').update(`${record.contextHash}\n${record.id}`).digest('hex')
          }
          if (record.status === 'PENDING') pendingContextHashes.add(record.contextHash)
          return record
        })
      } catch (error) {
        if (error?.code === 'ENOENT') return
        throw error
      }
      await migrateLegacyApprovalQueue({
        queueFilePath,
        store: safetyStore,
        records,
        marker: {
          id: markerId,
          kind: LEGACY_MIGRATION_KIND,
          status: 'IMPORTED',
          context: { source: 'hr-reply-approval-queue.json', version: 1 },
          contextHash: markerId,
          requestedBy: 'migration',
          expiresAt: LEGACY_APPROVAL_EXPIRY,
          createdAt: clock(),
          updatedAt: clock()
        }
      })
    })()
    return migration
  }

  async function list({ includeAll = false } = {}) {
    if (safetyStore) {
      await ensureMigrated()
      const requests = await safetyStore.listApprovals({ kind: AUTO_REPLY_KIND })
      const legacy = requests.map(fromStoreApproval)
      return includeAll ? legacy : legacy.filter((item) => item.status === 'pending')
    }
    return withQueueLock(queueFilePath, async () => {
      const queue = await readQueueFile(queueFilePath)
      if (!Array.isArray(queue)) return []
      return includeAll ? queue : queue.filter((item) => item.status === 'pending')
    }, lockOptions)
  }

  async function update(updater) {
    if (typeof updater !== 'function') throw new Error('approval queue updater is required')
    if (safetyStore) {
      const before = await list({ includeAll: true })
      const after = before.map((item) => ({ ...item }))
      const result = await updater(after)
      const beforeById = new Map(before.map((item) => [item.id, item]))
      for (const item of after) {
        const previous = beforeById.get(item.id)
        if (!previous) {
          await create(item)
          continue
        }
        if (JSON.stringify(previous) === JSON.stringify(item)) continue
        const stored = await safetyStore.getApproval(item.id)
        if (!stored || stored.kind !== AUTO_REPLY_KIND) continue
        const next = toStoreApproval(item, clock)
        await safetyStore.updateApproval(item.id, {
          status: next.status,
          context: next.context,
          contextHash: next.contextHash,
          reviewerNote: next.reviewerNote,
          reviewedAt: next.reviewedAt,
          updatedAt: clock()
        })
      }
      return result
    }
    return withQueueLock(queueFilePath, async () => {
      const queue = await readQueueFile(queueFilePath)
      if (!Array.isArray(queue)) throw new Error('approval queue must be an array')
      const result = await updater(queue)
      await writePrivateJson(queueFilePath, queue)
      return result
    }, lockOptions)
  }

  async function setStatus({ id, status, reason = '', extra = {} }) {
    if (!id) throw Object.assign(new Error('approval id is required'), { code: 'INVALID_PARAMS' })
    if (safetyStore) {
      await ensureMigrated()
      const existing = await safetyStore.getApproval(id)
      if (!existing || existing.kind !== AUTO_REPLY_KIND) throw Object.assign(new Error(`Approval request not found: ${id}`), { code: 'INVALID_PARAMS' })
      const current = fromStoreApproval(existing)
      const next = toStoreApproval({ ...current, ...extra, status, reviewReason: reason }, clock)
      const updated = await safetyStore.updateApproval(id, {
        status: next.status,
        context: next.context,
        contextHash: next.contextHash,
        reviewerNote: reason,
        reviewedAt: clock(),
        updatedAt: clock()
      })
      return fromStoreApproval(updated)
    }
    return update((queue) => {
      const item = queue.find((request) => request.id === id)
      if (!item) throw Object.assign(new Error(`Approval request not found: ${id}`), { code: 'INVALID_PARAMS' })
      Object.assign(item, {
        status,
        reviewedAt: clock().toISOString(),
        reviewReason: reason,
        ...extra
      })
      return { ...item }
    })
  }

  async function create(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw Object.assign(new Error('approval request must be an object'), { code: 'INVALID_PARAMS' })
    }
    if (safetyStore) {
      await ensureMigrated()
      const record = toStoreApproval(request, clock)
      const existing = (await safetyStore.listApprovals({ kind: AUTO_REPLY_KIND, status: 'PENDING' }))
        .find((item) => item.contextHash === record.contextHash)
      if (existing) return { created: false, request: fromStoreApproval(existing) }
      try {
        const created = await safetyStore.transaction((tx) => tx.insertApproval(record))
        const result = { created: true, request: fromStoreApproval(created) }
        emit('approval.required', result.request)
        return result
      } catch (error) {
        if (!/UNIQUE constraint failed/.test(error?.message)) throw error
        const duplicate = (await safetyStore.listApprovals({ kind: AUTO_REPLY_KIND, status: 'PENDING' }))
          .find((item) => item.contextHash === record.contextHash)
        if (!duplicate) throw error
        return { created: false, request: fromStoreApproval(duplicate) }
      }
    }
    const result = await update((queue) => {
      const dedupeKey = request.dedupeKey ?? approvalDedupeKey(request)
      const existing = queue.find((item) => item.dedupeKey === dedupeKey && item.status === 'pending')
      if (existing) return { created: false, request: { ...existing } }
      const item = {
        id: request.id ?? randomUUID(),
        dedupeKey,
        createdAt: request.createdAt ?? clock().toISOString(),
        hrName: request.hrName ?? '',
        company: request.company ?? '',
        jobTitle: request.jobTitle ?? '',
        latestHrMessage: request.latestHrMessage ?? '',
        detectedIntent: request.detectedIntent ?? 'UNKNOWN',
        draftReply: request.draftReply ?? '',
        draftSource: request.draftSource ?? (request.draftReply ? 'model_review_draft' : 'none'),
        draftSafety: request.draftSafety ?? 'needs_human_review',
        reason: request.reason ?? '',
        status: 'pending'
      }
      queue.push(item)
      return { created: true, request: { ...item } }
    })
    if (result.created) emit('approval.required', result.request)
    return result
  }

  const approve = (params) => setStatus({ ...params, status: 'approved_auto_reply' })
  const requireHuman = async (params) => {
    const item = await setStatus({ ...params, status: 'human_required' })
    emit('approval.required', item)
    return item
  }

  return { list, update, create, setStatus, approve, requireHuman, initialize: ensureMigrated }
}

export function readApprovalQueue({ queueFilePath = defaultApprovalQueueFilePath(), includeAll = false } = {}) {
  return createApprovalService({ queueFilePath }).list({ includeAll })
}

export function updateApprovalQueue({ queueFilePath = defaultApprovalQueueFilePath(), updater } = {}) {
  return createApprovalService({ queueFilePath }).update(updater)
}

function updateApprovalRequest({ id, status, queueFilePath = defaultApprovalQueueFilePath(), reason = '', extra = {} }) {
  return createApprovalService({ queueFilePath }).setStatus({ id, status, reason, extra })
}

export function approveAutoReply(options) {
  return updateApprovalRequest({ ...options, status: 'approved_auto_reply' })
}

export function requireHumanIntervention(options) {
  return updateApprovalRequest({ ...options, status: 'human_required' })
}

export function markAutoReplySent(options) {
  return updateApprovalRequest({
    ...options,
    status: 'auto_reply_sent',
    extra: { sentAt: new Date().toISOString() }
  })
}

export function markAutoReplyFailed(options) {
  return updateApprovalRequest({ ...options, status: 'auto_reply_failed' })
}

export function markAutoReplyExpired(options) {
  return updateApprovalRequest({ ...options, status: 'auto_reply_expired' })
}
