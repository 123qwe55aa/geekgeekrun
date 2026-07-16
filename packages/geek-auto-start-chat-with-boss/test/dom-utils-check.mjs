import assert from 'node:assert/strict'
import puppeteer from 'puppeteer'

import { findChatInput, findGreetCancelButton, findGreetSendButton, findSendButton, findStartChatButton, typeInChat, waitForText } from '../dom-utils.mjs'

const browser = await puppeteer.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.setContent(`
    <button id="outside"><span>聊一聊</span></button>
    <section class="job-detail-box">
      <button id="disabled" disabled><span>聊一聊</span></button>
      <button id="detail"><span>立即沟通</span></button>
    </section>
  `)

  const button = await findStartChatButton(page)
  assert.equal(await button.evaluate((element) => element.id), 'detail')

  await page.setContent(`
    <section class="job-detail-box">
      <a id="disabled-link" aria-disabled="true">聊一聊</a>
      <a id="detail-link" href="/web/geek/chat"><span>聊一聊</span></a>
    </section>
  `)
  const link = await findStartChatButton(page)
  assert.equal(await link.evaluate((element) => element.id), 'detail-link', 'start chat lookup supports the link control used by newer BOSS pages')

  await page.setContent(`
    <section class="job-detail-box">
      <div id="detail-role-button" role="button">立即沟通</div>
    </section>
  `)
  const roleButton = await findStartChatButton(page)
  assert.equal(await roleButton.evaluate((element) => element.id), 'detail-role-button')

  await page.setContent(`
    <button id="outside-send">发送</button>
    <div role="dialog" aria-label="打招呼">
      <button id="greet-send"><span>发送</span></button>
    </div>
  `)
  const greetSendButton = await findGreetSendButton(page)
  assert.equal(await greetSendButton.evaluate((element) => element.id), 'greet-send')
  await page.setContent('')
  await page.evaluate(() => setTimeout(() => {
    document.body.innerHTML = '<div role="dialog"><button id="delayed-greet-send">发送</button></div>'
  }, 50))
  const delayedGreetSendButton = await findGreetSendButton(page, { timeout: 500 })
  assert.equal(await delayedGreetSendButton.evaluate((element) => element.id), 'delayed-greet-send')
  await page.setContent(`
    <button id="outside-cancel">取消</button>
    <div role="dialog" aria-label="打招呼"><button id="greet-cancel">取消</button></div>
  `)
  const greetCancelButton = await findGreetCancelButton(page)
  assert.equal(await greetCancelButton.evaluate((element) => element.id), 'greet-cancel')

  await page.setContent('<textarea id="chat-input"></textarea>')
  await page.$eval('#chat-input', (element) => { element.value = 'existing greeting' })
  assert.equal(await typeInChat(page, 'new greeting', { delay: 0 }), true)
  assert.equal(await page.$eval('#chat-input', (element) => element.value), 'new greeting')

  await page.setContent('<button id="confirm"><span>确定</span></button>')
  const confirmButton = await waitForText(page, '确定', { tag: 'button' })
  assert.equal(await confirmButton.evaluate((element) => element.id), 'confirm')

  await page.setContent(`
    <button id="outside-send" class="btn-send">发送</button>
    <form class="chat-input-box">
      <textarea></textarea>
      <button id="chat-send" class="btn-send">发送</button>
    </form>
  `)
  const sendButton = await findSendButton(page)
  assert.equal(await sendButton.evaluate((element) => element.id), 'chat-send')

  await page.setContent(`
    <form class="chat-input-box">
      <textarea id="hidden-input" style="display:none"></textarea>
      <textarea id="chat-input"></textarea>
      <button id="hidden-send" class="btn-send" style="display:none">发送</button>
      <button id="disabled-send" class="btn-send" disabled>发送</button>
      <a id="chat-send-link" role="button">发送</a>
    </form>
  `)
  const visibleInput = await findChatInput(page)
  assert.equal(await visibleInput.evaluate((element) => element.id), 'chat-input', 'hidden composer templates must not be used')
  const visibleSend = await findSendButton(page)
  assert.equal(await visibleSend.evaluate((element) => element.id), 'chat-send-link', 'send lookup skips hidden and disabled controls')
} finally {
  await browser.close()
}

console.log('dom utils check passed')
