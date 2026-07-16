import os from 'node:os'
import path from 'node:path'
import { createGgrClient } from '../../ggr-client/index.mjs'

const WORKERS = Object.freeze({
  'auto-chat': 'geekAutoStartWithBossMain',
  'read-no-reply': 'readNoReplyAutoReminderMain'
})

function workerId(alias) {
  const value = WORKERS[alias]
  if (!value) throw new Error(`Unsupported worker: ${alias ?? ''}`)
  return value
}

function defaultSocket(name) {
  return path.join(os.homedir(), '.geekgeekrun', 'run', name)
}

function json(value) {
  return `${JSON.stringify(value)}\n`
}

function updateInstallParams(args) {
  let deadlineMs = 120_000
  let cancelRunningTasks = false
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--cancel-running-tasks') {
      cancelRunningTasks = true
      continue
    }
    if (argument === '--deadline-ms') {
      const value = Number(args[++index])
      if (!Number.isInteger(value) || value <= 0 || value > 10 * 60_000) {
        throw new Error('--deadline-ms must be an integer between 1 and 600000')
      }
      deadlineMs = value
      continue
    }
    throw new Error(`Unsupported update install option: ${argument ?? ''}`)
  }
  return { deadlineMs, cancelRunningTasks }
}

export function createCli({
  backendSocket = process.env.GGR_BACKEND_SOCKET ?? defaultSocket('backend.sock'),
  supervisorSocket = process.env.GGR_SUPERVISOR_SOCKET ?? defaultSocket('supervisor.sock'),
  clientVersion = process.env.GGR_CLIENT_VERSION ?? '0.0.0',
  write = (line) => process.stdout.write(line),
  clientFactory = createGgrClient
} = {}) {
  function client(socketPath, name, requestTimeoutMs = 30_000) {
    return clientFactory({
      socketPath,
      client: name,
      clientVersion,
      requestTimeoutMs
    })
  }

  async function request(socketPath, name, method, params = {}, { requestTimeoutMs = 30_000 } = {}) {
    const connection = client(socketPath, name, requestTimeoutMs)
    try {
      await connection.connect()
      return await connection.request(method, params)
    } finally {
      await connection.close()
    }
  }

  async function run(argv) {
    const [command, ...args] = argv
    let result
    switch (command) {
      case 'status':
        result = await request(backendSocket, 'ggr-cli', 'system.health')
        break
      case 'tasks':
        result = await request(backendSocket, 'ggr-cli', 'task.list')
        break
      case 'start': {
        const id = workerId(args[0])
        result = await request(backendSocket, 'ggr-cli', 'task.start', {
          workerId: id,
          options: { headless: args.includes('--headless') }
        })
        break
      }
      case 'stop': {
        result = await request(backendSocket, 'ggr-cli', 'task.stop', { workerId: workerId(args[0]) })
        break
      }
      case 'update': {
        const action = args[0]
        const methods = {
          status: 'supervisor.status',
          check: 'update.check',
          install: 'update.install',
          rollback: 'update.rollback'
        }
        if (!methods[action]) throw new Error(`Unsupported update command: ${action ?? ''}`)
        result = await request(
          supervisorSocket,
          'ggr-cli',
          methods[action],
          action === 'install' ? updateInstallParams(args.slice(1)) : {},
          action === 'install' ? { requestTimeoutMs: 125_000 } : {}
        )
        break
      }
      case 'safety': {
        const methods = {
          status: 'safety.status',
          config: 'safety.config.get',
          resume: 'safety.resume'
        }
        const action = args[0]
        if (!methods[action]) throw new Error(`Unsupported safety command: ${action ?? ''}`)
        result = await request(backendSocket, 'ggr-cli', methods[action])
        break
      }
      case 'approvals': {
        const action = args[0]
        const id = args[1]
        const reason = args.slice(2).join(' ')
        const withReason = reason ? { id, reason } : { id }
        if (action === 'list') {
          result = await request(backendSocket, 'ggr-cli', 'approval.list', { includeAll: false, kind: 'AUTO_CHAT' })
        } else if (action === 'show') {
          result = await request(backendSocket, 'ggr-cli', 'approval.get', { id })
        } else if (action === 'approve') {
          result = await request(backendSocket, 'ggr-cli', 'approval.approve', withReason)
        } else if (action === 'reject') {
          result = await request(backendSocket, 'ggr-cli', 'approval.reject', withReason)
        } else {
          throw new Error(`Unsupported approvals command: ${action ?? ''}`)
        }
        break
      }
      case 'queue': {
        if (args[0] !== 'list') throw new Error(`Unsupported queue command: ${args[0] ?? ''}`)
        result = await request(backendSocket, 'ggr-cli', 'approval.list', { includeAll: false, kind: 'AUTO_CHAT' })
        break
      }
      default:
        throw new Error('Usage: ggr <status|tasks|start|stop|update|safety|approvals|queue>')
    }
    write(json(result))
    return result
  }

  return { run }
}
