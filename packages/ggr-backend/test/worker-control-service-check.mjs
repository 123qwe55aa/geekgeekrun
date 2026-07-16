import assert from 'node:assert/strict'

import { createWorkerControlService } from '../lib/services/worker-control-service.mjs'

const calls = []
const policy = {
  status: async () => ({ status: 'RUNNING' }),
  recordBrowse: async (data) => { calls.push(['browse', data]); return { id: 'browse-1' } },
  createAutoChatApproval: async (data) => { calls.push(['candidate', data]); return { id: 'approval-1' } },
  consumeGrant: async (data) => { calls.push(['grant', data]); return { id: 'reservation-1' } },
  recordChatResult: async (data) => { calls.push(['chat', data]); return { id: 'result-1' } },
  detectRisk: async (data) => { calls.push(['risk', data]); return { status: 'PAUSED_RISK' } }
}
const stops = []
const control = createWorkerControlService({
  policy,
  task: { stop: async (data) => { stops.push(data) } }
})

assert.deepEqual(await control.handle({ workerId: 'auto', runRecordId: 7, type: 'agent.state', data: {} }), { status: 'RUNNING' })
assert.deepEqual(await control.handle({ workerId: 'auto', runRecordId: 7, type: 'browse.record', data: { jobId: 'job-1', workerId: 'spoofed', runRecordId: 'spoofed' } }), { id: 'browse-1' })
assert.deepEqual(await control.handle({ workerId: 'auto', runRecordId: 7, type: 'candidate.propose', data: { jobId: 'job-2', bossId: 'boss-2', companyId: 'company-2', workerId: 'spoofed', runRecordId: 'spoofed' } }), { id: 'approval-1' })
assert.deepEqual(await control.handle({ workerId: 'auto', runRecordId: 7, type: 'grant.consume', data: { grant: 'grant', jobId: 'job-3', bossId: 'boss-3', companyId: 'company-3', workerId: 'spoofed', runRecordId: 'spoofed' } }), { id: 'reservation-1' })
assert.deepEqual(await control.handle({ workerId: 'auto', runRecordId: 7, type: 'chat.result', data: { outcome: 'SENT', jobId: 'job-4', bossId: 'boss-4', companyId: 'company-4', workerId: 'spoofed', runRecordId: 'spoofed' } }), { id: 'result-1' })
assert.deepEqual(await control.handle({ workerId: 'auto', runRecordId: 7, type: 'risk.detected', data: { statusCode: 403 } }), { status: 'PAUSED_RISK' })

for (const [, data] of calls) {
  if (data.workerId !== undefined) assert.equal(data.workerId, 'auto', 'worker identity must be derived by the backend')
  if (data.runRecordId !== undefined) assert.equal(data.runRecordId, 7, 'run identity must be derived by the backend')
}
assert.deepEqual(stops, [{ workerId: 'auto', policyStop: true }], 'risk detection must intentionally stop its originating worker')
await assert.rejects(control.handle({ workerId: 'auto', runRecordId: 7, type: 'unknown', data: {} }), { code: 'INVALID_WORKER_CONTROL_TYPE' })

console.log('ggr backend worker control service check passed')
