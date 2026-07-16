function toIso(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function parseJson(value) {
  return JSON.parse(value)
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
    reviewerNote: row.reviewer_note,
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
        await manager.query(
          'INSERT INTO ggr_safety_event (scope_key, type, payload_json, created_at) VALUES (?, ?, ?, ?)',
          [scopeKey, type, JSON.stringify(payload), createdAtIso]
        )
        const [{ id }] = await manager.query('SELECT last_insert_rowid() AS id')
        return { id, scopeKey, type, payload, createdAt: createdAtIso }
      },
      async upsertState({ scopeKey, state, updatedAt = now() }) {
        const updatedAtIso = toIso(updatedAt)
        await manager.query(
          `INSERT INTO ggr_safety_state (scope_key, state_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(scope_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
          [scopeKey, JSON.stringify(state), updatedAtIso]
        )
        return { scopeKey, state, updatedAt: updatedAtIso }
      },
      async insertLedger({ scopeKey = null, actionType, actionKey = null, status, details = {}, createdAt = now() }) {
        const createdAtIso = toIso(createdAt)
        await manager.query(
          'INSERT INTO ggr_action_ledger (scope_key, action_type, action_key, status, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [scopeKey, actionType, actionKey, status, JSON.stringify(details), createdAtIso]
        )
        const [{ id }] = await manager.query('SELECT last_insert_rowid() AS id')
        return { id, scopeKey, actionType, actionKey, status, details, createdAt: createdAtIso }
      },
      async insertApproval({ id, kind, status = 'PENDING', context, contextHash, requestedBy = null, reviewerId = null, reviewerNote = null, reviewedAt = null, expiresAt, grantHash = null, createdAt = now(), updatedAt = now() }) {
        const createdAtIso = toIso(createdAt)
        const updatedAtIso = toIso(updatedAt)
        const reviewedAtIso = reviewedAt == null ? null : toIso(reviewedAt)
        const expiresAtIso = toIso(expiresAt)
        await manager.query(
          `INSERT INTO ggr_approval_request (id, kind, status, context_json, context_hash, requested_by, reviewer_id, reviewer_note, reviewed_at, expires_at, grant_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, kind, status, JSON.stringify(context), contextHash, requestedBy, reviewerId, reviewerNote, reviewedAtIso, expiresAtIso, grantHash, createdAtIso, updatedAtIso]
        )
        return { id, kind, status, context, contextHash, requestedBy, reviewerId, reviewerNote, reviewedAt: reviewedAtIso, expiresAt: expiresAtIso, grantHash, createdAt: createdAtIso, updatedAt: updatedAtIso }
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
        await manager.query(
          `UPDATE ggr_approval_request
           SET kind = ?, status = ?, context_json = ?, context_hash = ?, requested_by = ?, reviewer_id = ?, reviewer_note = ?, reviewed_at = ?, expires_at = ?, grant_hash = ?, updated_at = ?
           WHERE id = ?`,
          [next.kind, next.status, JSON.stringify(next.context), next.contextHash, next.requestedBy, next.reviewerId, next.reviewerNote, reviewedAtIso, expiresAtIso, next.grantHash, updatedAtIso, id]
        )
        return { ...next, reviewedAt: reviewedAtIso, expiresAt: expiresAtIso, updatedAt: updatedAtIso }
      },
      async setCompanyCooldown({ companyKey, reason, expiresAt, createdAt = now(), updatedAt = now() }) {
        const createdAtIso = toIso(createdAt)
        const updatedAtIso = toIso(updatedAt)
        const expiresAtIso = toIso(expiresAt)
        await manager.query(
          `INSERT INTO ggr_company_cooldown (company_key, reason, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(company_key) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
          [companyKey, reason, expiresAtIso, createdAtIso, updatedAtIso]
        )
        return { companyKey, reason, expiresAt: expiresAtIso, createdAt: createdAtIso, updatedAt: updatedAtIso }
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
