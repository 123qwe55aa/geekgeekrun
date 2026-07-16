import assert from 'node:assert/strict'
import {
  EVENTS,
  METHODS,
  PROTOCOL_VERSION,
  assertHandshake,
  createError,
  createRequest
} from '../index.mjs'

assert.equal(PROTOCOL_VERSION, 1)
assert.equal(METHODS.SYSTEM_HANDSHAKE, 'system.handshake')
assert.equal(METHODS.TASK_START, 'task.start')
assert.equal(METHODS.SAFETY_STATUS, 'safety.status')
assert.equal(METHODS.SAFETY_CONFIG_GET, 'safety.config.get')
assert.equal(METHODS.SAFETY_CONFIG_UPDATE, 'safety.config.update')
assert.equal(METHODS.SAFETY_RESUME, 'safety.resume')
assert.equal(METHODS.AGENT_STATUS, 'agent.status')
assert.equal(METHODS.APPROVAL_GET, 'approval.get')
assert.equal(METHODS.APPROVAL_REJECT, 'approval.reject')
assert.equal(EVENTS.TASK_PROGRESS, 'task.progress')
assert.equal(EVENTS.AGENT_STATE_CHANGED, 'agent.state_changed')
assert.equal(EVENTS.APPROVAL_APPROVED, 'approval.approved')
assert.equal(EVENTS.APPROVAL_REJECTED, 'approval.rejected')
assert.equal(EVENTS.CHAT_SENT, 'chat.sent')
assert.equal(EVENTS.CHAT_FAILED, 'chat.failed')
assert.equal(EVENTS.CHAT_UNKNOWN, 'chat.unknown')
assert.equal(EVENTS.QUOTA_BLOCKED, 'quota.blocked')
assert.equal(EVENTS.RISK_DETECTED, 'risk.detected')
assert.equal(EVENTS.RISK_CLEARED, 'risk.cleared')
assert.deepEqual(createRequest('r1', METHODS.TASK_START, { workerId: 'geekAutoStartWithBossMain' }), {
  id: 'r1', method: 'task.start', params: { workerId: 'geekAutoStartWithBossMain' }
})
assert.equal(assertHandshake({ client: 'electron', clientVersion: '0.17.4', protocolVersion: 1 }).client, 'electron')
assert.throws(() => assertHandshake({ client: '', protocolVersion: 1 }), /clientVersion/)
assert.deepEqual(createError('r2', 'METHOD_NOT_FOUND', 'missing'), {
  id: 'r2', error: { code: 'METHOD_NOT_FOUND', message: 'missing' }
})
console.log('ggr-protocol check passed')
