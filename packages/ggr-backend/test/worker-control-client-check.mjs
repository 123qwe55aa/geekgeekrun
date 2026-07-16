import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createWorkerControlClient } from '../lib/workers/worker-control-client.mjs'

{
  const channel = new EventEmitter()
  const sent = []
  const client = createWorkerControlClient({
    receive: channel.on.bind(channel),
    send: (message) => { sent.push(message) },
    timeoutMs: 50
  })
  const pending = client.request('candidate.propose', { jobId: 'job-1' })
  assert.deepEqual(sent[0], {
    ggrWorkerControl: 1,
    requestId: sent[0].requestId,
    type: 'candidate.propose',
    data: { jobId: 'job-1' }
  })
  channel.emit('message', { ggrWorkerControl: 1, requestId: 'another-request', ok: true, data: { ignored: true } })
  channel.emit('message', { ggrWorkerControl: 1, requestId: sent[0].requestId, ok: true, data: { grantForWorker: 'grant-1' } })
  assert.deepEqual(await pending, { grantForWorker: 'grant-1' })
}

{
  const channel = new EventEmitter()
  const client = createWorkerControlClient({ receive: channel.on.bind(channel), send: () => {}, timeoutMs: 5 })
  await assert.rejects(client.request('grant.consume', {}), { code: 'SAFETY_CHANNEL_UNAVAILABLE' })
  channel.emit('disconnect')
  await assert.rejects(client.request('browse.record', {}), { code: 'SAFETY_CHANNEL_UNAVAILABLE' })
}

{
  const channel = new EventEmitter()
  const client = createWorkerControlClient({ receive: channel.on.bind(channel), send: () => {}, timeoutMs: 50 })
  const pending = client.request('grant.consume', {})
  channel.emit('disconnect')
  await assert.rejects(pending, { code: 'SAFETY_CHANNEL_UNAVAILABLE' })
}

console.log('ggr backend worker control client check passed')
