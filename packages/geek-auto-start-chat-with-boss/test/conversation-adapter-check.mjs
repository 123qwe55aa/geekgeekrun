import assert from 'node:assert/strict'
import { sendConversationMessage } from '../conversation-adapter.mjs'

{
  const calls = []
  const result = await sendConversationMessage({
    page: { id: 'page' },
    text: '你好',
    findInput: async () => { calls.push('findInput'); return { id: 'composer' } },
    typeMessage: async (_page, text) => { calls.push(`type:${text}`); return true },
    findSend: async () => {
      calls.push('findSend')
      return { click: async () => calls.push('click') }
    },
    verifySent: async (_page, text) => { calls.push(`verify:${text}`); return true }
  })

  assert.deepEqual(result, { outcome: 'sent', text: '你好' })
  assert.deepEqual(calls, ['findInput', 'type:你好', 'findSend', 'click', 'verify:你好'])
}

await assert.rejects(
  () => sendConversationMessage({
    page: {},
    text: '你好',
    findInput: async () => ({ id: 'composer' }),
    typeMessage: async () => true,
    findSend: async () => null
  }),
  (error) => error?.code === 'CHAT_SEND_BUTTON_NOT_FOUND'
)

await assert.rejects(
  () => sendConversationMessage({
    page: {},
    text: ' ',
    findInput: async () => ({ id: 'composer' }),
    typeMessage: async () => true,
    findSend: async () => ({ click: async () => {} })
  }),
  (error) => error?.code === 'CHAT_MESSAGE_EMPTY'
)

console.log('conversation adapter checks passed')
