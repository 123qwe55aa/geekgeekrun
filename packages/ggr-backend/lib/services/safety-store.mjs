const REDACTED_SECRET = '[redacted]'
const SENSITIVE_FIELD_PATTERN = /(api[-_]?key|access[-_]?key|private[-_]?key|token|cookie|password|secret|credential|authorization|auth|webhook)/i
const SENSITIVE_ASSIGNMENT_PATTERN = /((?:api[-_]?key|access[-_]?key|private[-_]?key|token|cookie|password|secret|credential|authorization|webhook)\s*[=:]\s*)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|Bearer\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)|[^\s,;}\]]+)/gi

function toIso(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function redactInlineSecrets(value) {
  return value.replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1[redacted]')
}

function redactSecrets(value, key = '') {
  if (SENSITIVE_FIELD_PATTERN.test(key)) return REDACTED_SECRET
  if (typeof value === 'string') return redactInlineSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item))
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, redactSecrets(item, name)])
  )
  return value
}

function stringifySafeJson(value) {
  return JSON.stringify(redactSecrets(value))
}

function parseJson(value) {
  return redactSecrets(JSON.parse(value))
}

function mapState(row) {
  return row && { scopeKey: row.scope_key, state: parseJson(row.state_json), updatedAt: row.updated_at }
}

function mapEvent(row) {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    type: row.type,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at
  }
}

function mapApproval(row) {
  return row && {
    id: row.id,
    kind: row.kind,
    status: row.status,
    context: parseJson(row.context_json),
    contextHash: row.context_hash,
    requestedBy: row.requested_by,
    reviewerId: row.reviewer_id,
    reviewerNote: redactSecrets(row.reviewer_note),
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
    grantHash: row.grant_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapLedger(row) {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    actionType: row.action_type,
    actionKey: row.action_key,
    status: row.status,
    details: parseJson(row.details_json),
    createdAt: row.created_at
  }
}

function filtersToWhere(filters, allowed) {
  const clauses = []
  const values = []
  for (const [property, column] of Object.entries(allowed)) {
    if (filters[property] !== undefined) {
      clauses.push(`${column} = ?`)
      values.push(filters[property])
    }
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values }
}

export function createSafetyStore({ getDataSource, now = () => new Date() } = {}) {
  if (typeof getDataSource !== 'function') throw new TypeError('getDataSource is required')
  let dataSourcePromise = null

  async function dataSource() {
    dataSourcePromise ??= Promise.resolve().then(getDataSource)
    return dataSourcePromise
  }

  function createTransactionStore(manager) {
    return Object.freeze({
      async insertEvent({ scopeKey, type, payload = {}, createdAt = now() }) {
        const createdAtIso = toIso(createdAt)
        const safePayload = redactSecrets(payload)
        await manager.query(
          'INSERT INTO ggr_safety_event (scope_key, type, payload_json, created_at) VALUES (?, ?, ?, ?)',
          [scopeKey, type, stringifySafeJson(payload), createdAtIso]
        )
        const [{ id }] = await manager.query('SELECT last_insert_rowid() AS id')
        return { id, scopeKey, type, payload: safePayload, createdAt: createdAtIso }
      },
      async upsertState({ scopeKey, state, updatedAt = now() }) {
        const updatedAtIso = toIso(updatedAt)
        const safeState = redactSecrets(state)
        await manager.query(
          `INSERT INTO ggr_safety_state (scope_key, state_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(scope_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
          [scopeKey, stringifySafeJson(state), updatedAtIso]
        )
        return { scopeKey, state: safeState, updatedAt: updatedAtIso }
      },
      async insertLedger({ scopeKey = null, actionType, actionKey = null, status, details = {}, createdAt = now() }) {
        const createdAtIso = toIso(createdAt)
        const safeDetails = redactSecrets(details)
        await manager.query(
          'INSERT INTO ggr_action_ledger (scope_key, action_type, action_key, status, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [scopeKey, actionType, actionKey, status, stringifySafeJson(details), createdAtIso]
        )
        const [{ id }] = await manager.query('SELECT last_insert_rowid() AS id')
        return { id, scopeKey, actionType, actionKey, status, details: safeDetails, createdAt: createdAtIso }
      },
      async insertApproval({ id, kind, status = 'PENDING', context, contextHash, requestedBy = null, reviewerId = null, reviewerNote = null, reviewedAt = null, expiresAt, grantHash = null, createdAt = now(), updatedAt = now() }) {
        const createdAtIso = toIso(createdAt)
        const updatedAtIso = toIso(updatedAt)
        const reviewedAtIso = reviewedAt == null ? null : toIso(reviewedAt)
        const expiresAtIso = toIso(expiresAt)
        const safeContext = redactSecrets(context)
        const safeReviewerNote = redactSecrets(reviewerNote)
        await manager.query(
          `INSERT INTO ggr_approval_request (id, kind, status, context_json, context_hash, requested_by, reviewer_id, reviewer_note, reviewed_at, expires_at, grant_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, kind, status, stringifySafeJson(context), contextHash, requestedBy, reviewerId, safeReviewerNote, reviewedAtIso, expiresAtIso, grantHash, createdAtIso, updatedAtIso]
        )
        return { id, kind, status, context: safeContext, contextHash, requestedBy, reviewerId, reviewerNote: safeReviewerNote, reviewedAt: reviewedAtIso, expiresAt: expiresAtIso, grantHash, createdAt: createdAtIso, updatedAt: updatedAtIso }
      },
      async updateApproval(id, patch) {
        const current = await getApprovalWith(manager, id)
        if (!current) return null
        const next = {
          ...current,
          ...patch,
          context: patch.context ?? current.context,
          updatedAt: patch.updatedAt ?? now()
        }
        const updatedAtIso = toIso(next.updatedAt)
        const reviewedAtIso = next.reviewedAt == null ? null : toIso(next.reviewedAt)
        const expiresAtIso = toIso(next.expiresAt)
        const safeContext = redactSecrets(next.context)
        const safeReviewerNote = redactSecrets(next.reviewerNote)
        await manager.query(
          `UPDATE ggr_approval_request
           SET kind = ?, status = ?, context_json = ?, context_hash = ?, requested_by = ?, reviewer_id = ?, reviewer_note = ?, reviewed_at = ?, expires_at = ?, grant_hash = ?, updated_at = ?
           WHERE id = ?`,
          [next.kind, next.status, stringifySafeJson(next.context), next.contextHash, next.requestedBy, next.reviewerId, safeReviewerNote, reviewedAtIso, expiresAtIso, next.grantHash, updatedAtIso, id]
        )
        return { ...next, context: safeContext, reviewerNote: safeReviewerNote, reviewedAt: reviewedAtIso, expiresAt: expiresAtIso, updatedAt: updatedAtIso }
      },
      async setCompanyCooldown({ companyKey, reason, expiresAt, createdAt = now(), updatedAt = now() }) {
        const createdAtIso = toIso(createdAt)
        const updatedAtIso = toIso(updatedAt)
        const expiresAtIso = toIso(expiresAt)
        const safeReason = redactSecrets(reason)
        await manager.query(
          `INSERT INTO ggr_company_cooldown (company_key, reason, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(company_key) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
          [companyKey, safeReason, expiresAtIso, createdAtIso, updatedAtIso]
        )
        return { companyKey, reason: safeReason, expiresAt: expiresAtIso, createdAt: createdAtIso, updatedAt: updatedAtIso }
      }
    })
  }

  async function getApprovalWith(manager, id) {
    const [row] = await manager.query('SELECT * FROM ggr_approval_request WHERE id = ?', [id])
    return mapApproval(row)
  }

  async function initialize() {
    await dataSource()
  }

  async function transaction(callback) {
    if (typeof callback !== 'function') throw new TypeError('transaction callback is required')
    const runner = (await dataSource()).createQueryRunner()
    let begun = false
    let result
    let failure
    try {
      await runner.connect()
      await runner.query('BEGIN IMMEDIATE')
      begun = true
      result = await callback(createTransactionStore(runner.manager))
    } catch (error) {
      failure = error
    } finally {
      if (begun) {
        try { await runner.query(failure ? 'ROLLBACK' : 'COMMIT') } catch (finalizeError) { if (!failure) failure = finalizeError }
      }
      try { await runner.release() } catch (releaseError) { if (!failure) failure = releaseError }
    }
    if (failure) throw failure
    return result
  }

  async function readState(scope) {
    const scopeKey = typeof scope === 'string' ? scope : scope?.scopeKey
    const [row] = await (await dataSource()).manager.query('SELECT * FROM ggr_safety_state WHERE scope_key = ?', [scopeKey])
    return mapState(row)
  }

  async function appendEvent(event) {
    return transaction((tx) => tx.insertEvent(event))
  }

  async function listApprovals(filters = {}) {
    const { where, values } = filtersToWhere(filters, { kind: 'kind', status: 'status', contextHash: 'context_hash' })
    const rows = await (await dataSource()).manager.query(`SELECT * FROM ggr_approval_request${where} ORDER BY created_at ASC`, values)
    return rows.map(mapApproval)
  }

  async function getApproval(id) {
    return getApprovalWith((await dataSource()).manager, id)
  }

  async function updateApproval(id, patch) {
    return transaction((tx) => tx.updateApproval(id, patch))
  }

  async function listLedger(filters = {}) {
    const { where, values } = filtersToWhere(filters, { scopeKey: 'scope_key', actionType: 'action_type', status: 'status' })
    const rows = await (await dataSource()).manager.query(`SELECT * FROM ggr_action_ledger${where} ORDER BY created_at ASC, id ASC`, values)
    return rows.map(mapLedger)
  }

  async function listEvents(filters = {}) {
    const { where, values } = filtersToWhere(filters, { scopeKey: 'scope_key', type: 'type' })
    const rows = await (await dataSource()).manager.query(`SELECT * FROM ggr_safety_event${where} ORDER BY created_at ASC, id ASC`, values)
    return rows.map(mapEvent)
  }

  return Object.freeze({ initialize, readState, transaction, appendEvent, listApprovals, getApproval, updateApproval, listLedger, listEvents, close: async () => {} })
}
