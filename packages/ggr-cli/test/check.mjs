import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createCli } from '../lib/cli.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-cli-'))
const backendSocket = path.join(directory, 'backend.sock')
const supervisorSocket = path.join(directory, 'supervisor.sock')
const calls = []

async function listen(socketPath, handler) {
  const server = net.createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const request = JSON.parse(line)
        const result = handler(request)
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
      }
    })
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  return server
}

const backend = await listen(backendSocket, (request) => {
  calls.push(['backend', request.method, request.params])
  if (request.method === 'system.handshake') return { protocolMin: 1, protocolMax: 1 }
  if (request.method === 'system.health') return { version: '1.2.3', status: 'ok' }
  if (request.method === 'task.start') return { workerId: request.params.workerId, started: true }
  if (request.method === 'task.stop') return { workerId: request.params.workerId, stopped: true }
  if (request.method === 'task.list') return [{ workerId: 'auto-chat', status: 'running' }]
  if (request.method === 'safety.status') return { state: 'RUNNING' }
  if (request.method === 'safety.config.get') return { maxChatsPerHour: 5 }
  if (request.method === 'safety.resume') return { state: 'RUNNING' }
  if (request.method === 'approval.list') return [{ id: 'approval-1', kind: 'AUTO_CHAT' }]
  if (request.method === 'approval.get') return { id: request.params.id, kind: 'AUTO_CHAT' }
  if (request.method === 'approval.approve') return { id: request.params.id, status: 'APPROVED' }
  if (request.method === 'approval.reject') return { id: request.params.id, status: 'REJECTED' }
  throw new Error(`Unexpected backend method: ${request.method}`)
})
const supervisor = await listen(supervisorSocket, (request) => {
  calls.push(['supervisor', request.method, request.params])
  if (request.method === 'system.handshake') return { protocolMin: 1, protocolMax: 1 }
  if (request.method === 'supervisor.status') return { current: '1.2.3' }
  if (request.method === 'update.check') return { available: '1.2.4' }
  if (request.method === 'update.install') return { current: '1.2.4' }
  throw new Error(`Unexpected supervisor method: ${request.method}`)
})

const output = []
const clientOptions = []
const cli = createCli({
  backendSocket,
  supervisorSocket,
  clientVersion: '1.0.0',
  write: (line) => output.push(line)
})

await cli.run(['status'])
assert.deepEqual(JSON.parse(output.pop()), { version: '1.2.3', status: 'ok' })
await cli.run(['start', 'auto-chat', '--headless'])
assert.deepEqual(calls.at(-1), ['backend', 'task.start', { workerId: 'geekAutoStartWithBossMain', options: { headless: true } }])
await cli.run(['stop', 'read-no-reply'])
assert.deepEqual(calls.at(-1), ['backend', 'task.stop', { workerId: 'readNoReplyAutoReminderMain' }])
await cli.run(['update', 'check'])
assert.deepEqual(JSON.parse(output.pop()), { available: '1.2.4' })
await cli.run(['update', 'install', '--deadline-ms', '60000', '--cancel-running-tasks'])
assert.deepEqual(calls.at(-1), ['supervisor', 'update.install', { deadlineMs: 60000, cancelRunningTasks: true }])

const timeoutCli = createCli({
  write: () => {},
  clientFactory: (options) => {
    clientOptions.push(options)
    return {
      connected: false,
      async connect() { this.connected = true },
      async request() { return {} },
      async close() {}
    }
  }
})
await timeoutCli.run(['update', 'install'])
assert.equal(clientOptions.at(-1).requestTimeoutMs, 125000, 'the CLI must wait longer than the default backend-install deadline')
assert.equal(calls.some(([target]) => target === 'supervisor'), true)
await cli.run(['safety', 'status'])
assert.deepEqual(calls.at(-1), ['backend', 'safety.status', {}])
await cli.run(['safety', 'config'])
assert.deepEqual(calls.at(-1), ['backend', 'safety.config.get', {}])
await cli.run(['safety', 'resume'])
assert.deepEqual(calls.at(-1), ['backend', 'safety.resume', {}])
await cli.run(['approvals', 'list'])
assert.deepEqual(calls.at(-1), ['backend', 'approval.list', { includeAll: false, kind: 'AUTO_CHAT' }])
await cli.run(['queue', 'list'])
assert.deepEqual(calls.at(-1), ['backend', 'approval.list', { includeAll: false, kind: 'AUTO_CHAT' }])
await cli.run(['approvals', 'show', 'approval-1'])
assert.deepEqual(calls.at(-1), ['backend', 'approval.get', { id: 'approval-1' }])
await cli.run(['approvals', 'approve', 'approval-1', 'looks good'])
assert.deepEqual(calls.at(-1), ['backend', 'approval.approve', { id: 'approval-1', reason: 'looks good' }])
await cli.run(['approvals', 'reject', 'approval-1', 'not now'])
assert.deepEqual(calls.at(-1), ['backend', 'approval.reject', { id: 'approval-1', reason: 'not now' }])
assert.doesNotMatch(await fs.readFile(new URL('../lib/cli.mjs', import.meta.url), 'utf8').catch(() => ''), /child_process/)

await Promise.all([
  new Promise((resolve) => backend.close(resolve)),
  new Promise((resolve) => supervisor.close(resolve))
])
await fs.rm(directory, { recursive: true, force: true })
console.log('ggr-cli check passed')
