import { fileURLToPath } from 'node:url'
import { createWorkerReporter } from './worker-reporter.mjs'
import { createWorkerControlClient } from './worker-control-client.mjs'

const WORKER_ID = 'geekAutoStartWithBossMain'

function reporter(value) {
  if (!value || typeof value.emit !== 'function') throw new TypeError('taskReporter.emit is required')
  return value
}

export async function runAutoChat({ runtime, taskReporter, shouldStop }) {
  if (!runtime || typeof runtime.runOnce !== 'function') throw new TypeError('runtime.runOnce is required')
  if (typeof shouldStop !== 'function') throw new TypeError('shouldStop is required')
  const reports = reporter(taskReporter)
  try {
    while (!(await shouldStop())) await runtime.runOnce({ taskReporter: reports })
    reports.emit('task.progress', { workerId: WORKER_ID, state: 'completed' })
  } catch (error) {
    const stable = error instanceof Error ? error : new Error(String(error))
    stable.code ??= 'AUTO_CHAT_FAILED'
    reports.emit('task.progress', { workerId: WORKER_ID, state: 'failed', code: stable.code, message: stable.message })
    throw stable
  }
}

export async function runAutoChatEntry({
  createRuntime,
  controlClient = createWorkerControlClient(),
  taskReporter = createWorkerReporter(),
  shouldStop = async () => false
} = {}) {
  const reports = reporter(taskReporter)
  const runtimeFactory = createRuntime ?? (async ({ controlClient: client }) => {
    const { createAutoChatRuntime } = await import('./auto-chat-runtime.mjs')
    return createAutoChatRuntime({ controlClient: client })
  })
  let runtime
  try {
    runtime = await runtimeFactory({ controlClient })
  } catch (error) {
    const stable = error instanceof Error ? error : new Error(String(error))
    stable.code ??= 'AUTO_CHAT_FAILED'
    reports.emit('task.progress', { workerId: WORKER_ID, state: 'runtime-error', code: stable.code, message: stable.message })
    throw stable
  }
  return runAutoChat({ runtime, taskReporter: reports, shouldStop })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let stopping = false
  process.once('SIGINT', () => { stopping = true })
  process.once('SIGTERM', () => { stopping = true })
  await runAutoChatEntry({
    controlClient: createWorkerControlClient(),
    taskReporter: createWorkerReporter(),
    shouldStop: async () => stopping
  })
}
