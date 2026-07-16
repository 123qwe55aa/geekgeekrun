function unavailable(message = 'worker safety control channel is unavailable') {
  return Object.assign(new Error(message), { code: 'SAFETY_CHANNEL_UNAVAILABLE' })
}

function replyError(reply) {
  const error = reply?.error ?? {}
  return Object.assign(new Error(typeof error.message === 'string' ? error.message : 'worker safety control request failed'), {
    code: typeof error.code === 'string' ? error.code : 'WORKER_CONTROL_FAILED',
    ...(error.data === undefined ? {} : { data: error.data })
  })
}

export function createWorkerControlClient({ send = process.send?.bind(process), receive = process.on.bind(process), timeoutMs = 30_000 } = {}) {
  if (typeof receive !== 'function') throw new TypeError('receive must be a function')
  let nextRequestId = 0
  let connected = typeof send === 'function'
  const pending = new Map()

  const rejectAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    pending.clear()
  }

  receive('message', (reply) => {
    if (!reply || reply.ggrWorkerControl !== 1 || !pending.has(reply.requestId)) return
    const request = pending.get(reply.requestId)
    pending.delete(reply.requestId)
    clearTimeout(request.timer)
    if (reply.ok === true) request.resolve(reply.data)
    else request.reject(replyError(reply))
  })
  receive('disconnect', () => {
    connected = false
    rejectAll(unavailable())
  })

  function request(type, data, { timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
    if (!connected || typeof send !== 'function') return Promise.reject(unavailable())
    const requestId = `worker-control-${++nextRequestId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(requestId)) return
        reject(unavailable('worker safety control channel timed out'))
      }, requestTimeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      try {
        send({ ggrWorkerControl: 1, requestId, type, data })
      } catch {
        if (!pending.delete(requestId)) return
        clearTimeout(timer)
        reject(unavailable())
      }
    })
  }

  return Object.freeze({ request })
}
