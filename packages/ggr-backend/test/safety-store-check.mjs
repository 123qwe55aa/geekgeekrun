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
} finally {
  await store.close()
  await database.destroy()
  await fs.rm(tempHome, { recursive: true, force: true })
}

console.log('ggr backend safety store check passed')
