import { connectBackend } from './client'

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const isDevelopment = () => process.env.NODE_ENV === 'development'

async function waitForBackend() {
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await connectBackend()
    } catch (error) {
      lastError = error
      await sleep(250)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Backend did not become ready')
}

export async function ensureBackendReady(): Promise<void> {
  if (isDevelopment()) {
    try {
      await connectBackend()
      return
    } catch (error) {
      throw new Error(`Development backend is unavailable. Run pnpm dev:backend and set GGR_BACKEND_SOCKET if needed. ${error instanceof Error ? error.message : ''}`)
    }
  }
  try {
    await waitForBackend()
  } catch (error) {
    throw new Error(`GGR Runtime is unavailable. Install or start the separate GGR Runtime, then retry. ${error instanceof Error ? error.message : ''}`)
  }
}
