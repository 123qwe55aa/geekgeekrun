const handlers = new Map()

const invalidParams = (message) => Object.assign(new Error(message), { code: 'INVALID_PARAMS' })

function onlyKeys(params, allowed) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalidParams('RPC params must be an object')
  const unexpected = Object.keys(params).find((key) => !allowed.has(key))
  if (unexpected) throw invalidParams(`Unsupported parameter: ${unexpected}`)
  return params
}

export const register = (method, handler) => handlers.set(method, handler)

export async function dispatch(request, context) {
  const handler = context?.handlers?.get(request.method) ?? handlers.get(request.method)
  if (!handler) throw Object.assign(new Error(`Unknown method: ${request.method}`), { code: 'METHOD_NOT_FOUND' })
  return handler(request.params ?? {}, context)
}

export function createRouter(entries = []) {
  const localHandlers = new Map(entries)
  return {
    register(method, handler) { localHandlers.set(method, handler); return this },
    dispatch(request, context = {}) { return dispatch(request, { ...context, handlers: localHandlers }) }
  }
}

export function registerServiceHandlers(router, { methods, task, approval, policy, getSafetyApproval }) {
  return router
    .register(methods.SYSTEM_UPDATE_DRAIN, (params) => {
      onlyKeys(params, new Set(['enabled']))
      return task.setUpdateDrain(params)
    })
    .register(methods.TASK_LIST, (params) => {
      onlyKeys(params, new Set())
      return task.list()
    })
    .register(methods.TASK_START, (params) => {
      onlyKeys(params, new Set(['workerId', 'options']))
      return task.start(params)
    })
    .register(methods.TASK_STOP, (params) => {
      onlyKeys(params, new Set(['workerId']))
      return task.stop(params)
    })
    .register(methods.APPROVAL_LIST, (params) => {
      onlyKeys(params, new Set(['includeAll']))
      if (params.includeAll !== undefined && typeof params.includeAll !== 'boolean') throw invalidParams('includeAll must be a boolean')
      return approval.list({ includeAll: params.includeAll })
    })
    .register(methods.APPROVAL_CREATE, (params) => {
      onlyKeys(params, new Set(['request']))
      return approval.create(params.request)
    })
    .register(methods.APPROVAL_APPROVE, async (params, context) => {
      onlyKeys(params, new Set(['id', 'reason']))
      if (await getSafetyApproval?.(params.id)) return policy.approve({ id: params.id, actor: context?.handshake })
      return approval.approve(params)
    })
    .register(methods.APPROVAL_REQUIRE_HUMAN, (params) => {
      onlyKeys(params, new Set(['id', 'reason']))
      return approval.requireHuman(params)
    })
    .register(methods.SAFETY_STATUS, (params) => {
      onlyKeys(params, new Set())
      return policy.status()
    })
    .register(methods.SAFETY_CONFIG_GET, (params) => {
      onlyKeys(params, new Set())
      return policy.getConfig()
    })
    .register(methods.SAFETY_CONFIG_UPDATE, (params) => {
      onlyKeys(params, new Set(['patch']))
      return policy.updateConfig(params.patch)
    })
    .register(methods.SAFETY_RESUME, (params) => {
      onlyKeys(params, new Set())
      return policy.resume()
    })
    .register(methods.AGENT_STATUS, async (params) => {
      onlyKeys(params, new Set())
      return { tasks: await task.list(), policy: await policy.status() }
    })
    .register(methods.APPROVAL_GET, async (params) => {
      onlyKeys(params, new Set(['id']))
      if (typeof params.id !== 'string' || !params.id) throw invalidParams('approval id is required')
      const request = await getSafetyApproval?.(params.id)
      if (!request) throw Object.assign(new Error('approval was not found'), { code: 'APPROVAL_NOT_FOUND' })
      return request
    })
    .register(methods.APPROVAL_REJECT, (params, context) => {
      onlyKeys(params, new Set(['id', 'reason']))
      return policy.reject({ id: params.id, reason: params.reason, actor: context?.handshake })
    })
}
