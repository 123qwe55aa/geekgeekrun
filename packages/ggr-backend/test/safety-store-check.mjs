import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { initDb } from '@geekgeekrun/sqlite-plugin'
import { createSafetyStore } from '../lib/services/safety-store.mjs'

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-safety-store-'))
const databaseFile = path.join(tempHome, 'database.sqlite')
const now = new Date('2026-07-16T00:00:00.000Z')
const database = await initDb(databaseFile)
const store = createSafetyStore({ getDataSource: async () => database, now: () => now })

try {
  await store.initialize()

  const tables = await database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ggr_%' ORDER BY name")
  assert.deepEqual(tables.map(({ name }) => name), [
    'ggr_action_ledger',
    'ggr_approval_request',
    'ggr_company_cooldown',
    'ggr_safety_event',
    'ggr_safety_state'
  ])

  await assert.rejects(store.transaction(async (tx) => {
    await tx.insertEvent({ scopeKey: 'auto-chat', type: 'risk.detected', payload: {} })
    throw new Error('rollback')
  }), /rollback/)
  assert.equal((await store.listEvents({ scopeKey: 'auto-chat' })).length, 0)

  await store.transaction(async (tx) => {
    await tx.insertApproval({
      id: 'approval-one',
      kind: 'AUTO_CHAT',
      context: { companyId: 'company-one' },
      contextHash: 'context-one',
      expiresAt: new Date('2026-07-17T00:00:00.000Z')
    })
  })
  await assert.rejects(store.transaction(async (tx) => {
    await tx.insertApproval({
      id: 'approval-two',
      kind: 'AUTO_CHAT',
      context: { companyId: 'company-one' },
      contextHash: 'context-one',
      expiresAt: new Date('2026-07-17T00:00:00.000Z')
    })
  }), /UNIQUE constraint failed/)

  const rawSecret = 'never-store-this-cookie-token'
  const event = await store.appendEvent({
    scopeKey: 'auto-chat',
    type: 'risk.detected',
    payload: { safe: 'shown', nested: { apiToken: rawSecret } }
  })
  const approval = await store.transaction((tx) => tx.insertApproval({
    id: 'approval-redacted',
    kind: 'AUTO_CHAT',
    context: { safe: 'shown', sessionCookie: rawSecret },
    contextHash: 'context-redacted',
    expiresAt: new Date('2026-07-17T00:00:00.000Z')
  }))
  const ledger = await store.transaction((tx) => tx.insertLedger({
    actionType: 'AUTO_CHAT',
    status: 'BLOCKED',
    details: { safe: 'shown', authorization: `Bearer ${rawSecret}` }
  }))
  const storedJson = await database.query(
    "SELECT payload_json AS value FROM ggr_safety_event WHERE type = 'risk.detected' UNION ALL SELECT context_json AS value FROM ggr_approval_request WHERE id = 'approval-redacted' UNION ALL SELECT details_json AS value FROM ggr_action_ledger WHERE id = ?",
    [ledger.id]
  )
  const storedEvent = (await store.listEvents({ type: 'risk.detected' })).at(-1)
  const storedApproval = await store.getApproval('approval-redacted')
  const storedLedger = (await store.listLedger({ actionType: 'AUTO_CHAT' })).at(-1)
  const returnedDtos = [event, approval, ledger, storedEvent, storedApproval, storedLedger]
  assert(!JSON.stringify(storedJson).includes(rawSecret), 'SQLite must not persist raw secrets')
  assert(!JSON.stringify(returnedDtos).includes(rawSecret), 'safety DTOs must not return raw secrets')
  assert.deepEqual(storedEvent, event, 'event JSON and timestamp must round-trip')
  assert.deepEqual(storedApproval, approval, 'approval JSON and timestamps must round-trip')
  assert.equal(event.createdAt, now.toISOString())
  assert.equal(approval.createdAt, now.toISOString())
  assert.equal(approval.context.safe, 'shown')
} finally {
  await store.close()
  await database.destroy()
  await fs.rm(tempHome, { recursive: true, force: true })
}

console.log('ggr backend safety store check passed')
