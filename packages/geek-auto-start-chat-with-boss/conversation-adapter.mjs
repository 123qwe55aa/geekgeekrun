import { findChatInput, findSendButton, typeInChat } from './dom-utils.mjs'

function chatFailure(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Send a text message through an already-open BOSS conversation.
 *
 * Opening a job conversation and selecting an existing conversation are
 * deliberately outside this adapter: those are separate page states.  Once a
 * composer is visible, both workflows use this single DOM-facing operation.
 */
export async function sendConversationMessage({
  page,
  text,
  findInput = findChatInput,
  typeMessage = typeInChat,
  findSend = findSendButton,
  verifySent = null
} = {}) {
  if (!page) throw new TypeError('page is required')
  if (typeof text !== 'string' || !text.trim()) {
    throw chatFailure('CHAT_MESSAGE_EMPTY', 'chat message must not be empty')
  }

  const input = await findInput(page)
  if (!input) throw chatFailure('CHAT_INPUT_NOT_FOUND', 'chat input is unavailable')

  if (!await typeMessage(page, text)) {
    throw chatFailure('CHAT_INPUT_NOT_FOUND', 'chat input is unavailable')
  }

  const sendButton = await findSend(page)
  if (!sendButton) {
    throw chatFailure('CHAT_SEND_BUTTON_NOT_FOUND', 'chat send button is unavailable')
  }
  await sendButton.click()

  if (verifySent && !await verifySent(page, text)) {
    throw chatFailure('CHAT_SEND_UNVERIFIED', 'chat message could not be verified')
  }

  return { outcome: 'sent', text }
}
