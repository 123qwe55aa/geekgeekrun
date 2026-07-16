/**
 * Text-based DOM query helpers — resilient to BOSS frontend class name changes.
 *
 * Strategy:
 *   1. Try XPath by visible text (buttons, dialogs)
 *   2. Fall back to contenteditable / semantic attributes
 *   3. Last resort: original brittle selector
 */

/**
 * Find an element by its visible text content within a container.
 * Uses XPath `contains(text(), ...)` which is immune to class changes.
 */
function buttonXPath(texts) {
  return `xpath/.//button[not(@disabled) and (${texts.map((text) => `contains(normalize-space(.), ${JSON.stringify(text)})`).join(' or ')})]`
}

function actionXPath(texts) {
  const textMatch = texts.map((text) => `contains(normalize-space(.), ${JSON.stringify(text)})`).join(' or ')
  return `xpath/.//*[self::button or self::a or @role='button'][not(@disabled) and not(@aria-disabled='true') and (${textMatch})]`
}

function textXPath(text, tag) {
  return `xpath///${tag}[contains(normalize-space(.), ${JSON.stringify(text)})]`
}

async function findVisibleButtonByText(scope, texts) {
  const buttons = await scope.$$(buttonXPath(texts))
  for (const button of buttons) {
    if (await button.evaluate((element) => {
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
    })) return button
  }
  return null
}

async function findVisibleActionByText(scope, texts) {
  const actions = await scope.$$(actionXPath(texts))
  for (const action of actions) {
    if (await isVisibleAndEnabled(action)) return action
  }
  return null
}

async function isVisibleAndEnabled(element) {
  return element.evaluate((node) => {
    const style = window.getComputedStyle(node)
    return !node.matches(':disabled, .disabled, [aria-disabled="true"]') &&
      style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
  })
}

async function findVisibleSelector(scope, selectors, timeout) {
  const deadline = Date.now() + timeout
  while (true) {
    for (const selector of selectors) {
      for (const element of await scope.$$(selector)) {
        if (await isVisibleAndEnabled(element)) return element
      }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)))
  }
}

export async function findStartChatButton(page, { detailSelector = '.job-detail-box' } = {}) {
  const detail = await page.$(detailSelector)
  if (!detail) return null
  // BOSS has rendered this action as both a native button and an anchor/role
  // button across frontend versions.  Restrict the text lookup to the job
  // detail panel so unrelated navigation actions cannot be clicked.
  return findVisibleActionByText(detail, ['聊一聊', '立即沟通'])
}

export async function findByText(page, text, { tag = '*', timeout = 5000 } = {}) {
  try {
    return await page.waitForSelector(textXPath(text, tag), { timeout })
  } catch {
    return null
  }
}

/**
 * Find ALL elements matching text content (for disambiguation).
 */
export async function findAllByText(page, text, { tag = '*' } = {}) {
  return page.$$(textXPath(text, tag))
}

/**
 * Wait for and return an element by text content.
 * Throws if not found within timeout (like waitForSelector).
 */
export async function waitForText(page, text, { tag = '*', timeout = 10000 } = {}) {
  return page.waitForSelector(textXPath(text, tag), { timeout })
}

/**
 * Click an element by text content. Returns true if clicked, false otherwise.
 */
export async function clickByText(page, text, { tag = '*', timeout = 5000 } = {}) {
  const el = await findByText(page, text, { tag, timeout })
  if (!el) return false
  await el.click()
  return true
}

/**
 * Find the chat input element — uses contenteditable attribute which is
 * semantically stable, with CSS class fallback.
 */
export async function findChatInput(page, { timeout = 10000 } = {}) {
  // The page keeps hidden composer templates in the DOM.  Returning one of
  // those makes later typing appear to succeed while no message is sent.
  const selectors = [
    '[contenteditable="true"]',
    '[role="textbox"]',
    'textarea',
    'input[type="text"]'
  ]
  // Search inside the conversation first: BOSS pages can include unrelated
  // rich-text editors elsewhere in the document.
  const conversation = await page.$('.chat-conversation')
  if (conversation) return findVisibleSelector(conversation, selectors, timeout)
  return findVisibleSelector(page, selectors, timeout)
}

/**
 * Find the send button in a chat area — uses multiple strategies.
 * BOSS typically uses an icon button with class containing "send" or "btn-send".
 */
export async function findSendButton(page, { timeout = 5000 } = {}) {
  try {
    const input = await findChatInput(page, { timeout })
    if (!input) return null
    const containerHandle = await input.evaluateHandle((element) =>
      element.closest('form') ?? element.closest('.chat-input-box, [class*="chat-input"], .chat-conversation') ?? element.parentElement
    )
    const container = containerHandle.asElement()
    if (!container) return null
    const selectors = [
      '[class*="btn-send"]',
      '[class*="send"]',
      '[data-testid="send-button"]',
      'button[class*="chat"]',
      '[class*="icon-message-send"]',
    ]
    for (const sel of selectors) {
      for (const el of await container.$$(sel)) {
        if (await isVisibleAndEnabled(el)) return el
      }
    }
    const localTextButton = await findVisibleActionByText(container, ['发送'])
    if (localTextButton) return localTextButton
    // Current BOSS chat pages render the composer input and the send action
    // as siblings, so the action is outside the input's nearest container.
    return findVisibleSelector(page, [
      '.chat-conversation .message-controls .chat-op .btn-send:not(.disabled)',
      '.chat-conversation .message-controls [class*="btn-send"]:not(.disabled)',
      '.chat-conversation [data-testid="send-button"]',
      '.chat-conversation [class*="icon-message-send"]'
    ], timeout)
  } catch {
    return null
  }
}

/**
 * Type text into the chat input field.
 */
export async function typeInChat(page, text, { delay = 30 } = {}) {
  const input = await findChatInput(page)
  if (!input) return false
  await input.click()
  await input.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) element.value = ''
    else element.textContent = ''
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }))
  })
  await input.type(text, { delay })
  return true
}

/**
 * Wait for and find the greet dialog button (send or primary action).
 */
export async function findGreetSendButton(page, { timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout
  while (true) {
    const dialogs = await page.$$('[role="dialog"], .greet-boss-dialog')
    for (const dialog of dialogs) {
      const button = await findVisibleActionByText(dialog, ['发送'])
      if (button) return button
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)))
  }
}

export async function findGreetCancelButton(page) {
  const dialogs = await page.$$('[role="dialog"], .greet-boss-dialog')
  for (const dialog of dialogs) {
    const button = await findVisibleActionByText(dialog, ['取消'])
    if (button) return button
  }
  return null
}
