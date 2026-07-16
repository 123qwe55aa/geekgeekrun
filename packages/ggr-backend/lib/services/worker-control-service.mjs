const CONTROL_TYPES = new Set([
  'agent.state',
  'browse.record',
  'candidate.propose',
  'grant.consume',
  'chat.result',
  'risk.detected',
  'approval.list',
  'approval.create',
  'approval.setStatus'
])

const AUTO_CHAT_CONTROL_TYPES = new Set([
  'agent.state',
  'browse.record',
  'candidate.propose',
  'grant.consume',
  'chat.result',
  'risk.detected'
])

const READ_NO_REPLY_CONTROL_TYPES = new Set([
  'approval.list',
  'approval.create',
  'approval.setStatus'
])

const WORKER_CONTROL_TYPES = new Map([
  ['geekAutoStartWithBossMain', AUTO_CHAT_CONTROL_TYPES],
  ['readNoReplyAutoReminderMain', READ_NO_REPLY_CONTROL_TYPES]
])

function failure(code, message) {
  return Object.assign(new Error(message), { code })
}

function assertMessage({ workerId, runRecordId, type, data } = {}) {
  if (typeof workerId !== 'string' || !workerId) throw failure('INVALID_WORKER_CONTROL_CONTEXT', 'workerId is required')
  if (runRecordId === undefined || runRecordId === null || runRecordId === '') throw failure('INVALID_WORKER_CONTROL_CONTEXT', 'runRecordId is required')
  if (!CONTROL_TYPES.has(type)) throw failure('INVALID_WORKER_CONTROL_TYPE', `Unsupported worker control type: ${type}`)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('INVALID_WORKER_CONTROL_DATA', 'worker control data must be an object')
}

function assertWorkerControlAllowed(workerId, type) {
  if (!WORKER_CONTROL_TYPES.get(workerId)?.has(type)) {
    throw failure('INVALID_WORKER_CONTROL', `Worker ${workerId} cannot use worker control type: ${type}`)
  }
}

function derivedData(data, workerId, runRecordId) {
  return { ...data, workerId, runRecordId }
}

export function createWorkerControlService({ policy, task, approval, scheduleStop = setImmediate } = {}) {
  if (!policy || typeof policy !== 'object') throw new TypeError('policy is required')
  if (!task || typeof task.stop !== 'function') throw new TypeError('task.stop is required')
  if (typeof scheduleStop !== 'function') throw new TypeError('scheduleStop must be a function')

  async function handle(message = {}) {
    const { workerId, runRecordId, type, data } = message
    assertMessage(message)
    assertWorkerControlAllowed(workerId, type)
    const routedData = derivedData(data, workerId, runRecordId)

    switch (type) {
      case 'agent.state': return policy.status()
      case 'browse.record': return policy.recordBrowse(routedData)
      case 'candidate.propose': return policy.createAutoChatApproval(routedData)
      case 'grant.consume': return policy.consumeGrant(routedData)
      case 'chat.result': return policy.recordChatResult(routedData)
      case 'risk.detected': {
        const state = await policy.detectRisk(routedData)
        scheduleStop(() => { void Promise.resolve().then(() => task.stop({ workerId, policyStop: true })).catch(() => {}) })
        return state
      }
      case 'approval.list':
      case 'approval.create':
      case 'approval.setStatus':
        if (!approval || typeof approval.list !== 'function' || typeof approval.create !== 'function' || typeof approval.setStatus !== 'function') throw failure('APPROVAL_UNAVAILABLE', 'backend approval operations are unavailable')
        if (type === 'approval.list') return approval.list(routedData)
        if (type === 'approval.create') return approval.create(routedData.request)
        return approval.setStatus(routedData)
    }
  }

  return Object.freeze({ handle })
}
