import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runApprovedNewChatAttempt } from '../index.mjs'

const job = { jobInfo: { encryptId: 'job-1', encryptUserId: 'boss-1' }, brandName: 'Acme' }

{
  const events = []
  let resolveApproval
  const approval = new Promise((resolve) => { resolveApproval = resolve })
  const hooks = {
    newChatWillStartup: { promise: async (context) => { events.push(['will', context]); await approval } },
    newChatAttempted: { promise: async (context) => events.push(['attempted', context]) },
    newChatOutcome: { promise: async (context, outcome) => events.push(['outcome', context, outcome]) }
  }
  let clicks = 0
  const attempt = runApprovedNewChatAttempt({
    hooks,
    page: { url: () => 'https://www.zhipin.com/web/geek/jobs' },
    targetJobData: job,
    startChatButtonProxy: { click: async () => { clicks++ } },
    waitForAddFriendResponse: async () => ({ code: 0 }),
    handleAddFriendResponse: async () => { events.push(['response']); return { outcome: 'sent' } }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(clicks, 0, 'the BOSS send click must wait for approval')
  resolveApproval()
  await attempt
  assert.deepEqual(events, [
    ['will', { pageUrl: 'https://www.zhipin.com/web/geek/jobs', job, sendControlPresent: true }],
    ['attempted', { pageUrl: 'https://www.zhipin.com/web/geek/jobs', job, sendControlPresent: true }],
    ['response'],
    ['outcome', { pageUrl: 'https://www.zhipin.com/web/geek/jobs', job, sendControlPresent: true }, 'sent']
  ])
  assert.equal(clicks, 1)
}

{
  const outcomes = []
  await runApprovedNewChatAttempt({
    hooks: {
      newChatWillStartup: { promise: async () => {} },
      newChatAttempted: { promise: async () => {} },
      newChatOutcome: { promise: async (_context, outcome) => outcomes.push(outcome) }
    },
    page: { url: () => 'https://www.zhipin.com/web/geek/jobs' },
    targetJobData: job,
    startChatButtonProxy: { click: async () => {} },
    waitForAddFriendResponse: async () => ({ code: 0 }),
    handleAddFriendResponse: async () => undefined
  })
  assert.deepEqual(outcomes, ['unknown'], 'an unverified delivery must not consume a sent outcome')
}

{
  let clicks = 0
  const hooks = {
    newChatWillStartup: { promise: async () => { throw Object.assign(new Error('approval expired'), { code: 'APPROVAL_EXPIRED' }) } },
    newChatAttempted: { promise: async () => assert.fail('attempt hook must not run without approval') }
  }
  await assert.rejects(runApprovedNewChatAttempt({
    hooks,
    page: { url: () => 'https://www.zhipin.com/web/geek/jobs' },
    targetJobData: job,
    startChatButtonProxy: { click: async () => { clicks++ } },
    waitForAddFriendResponse: async () => ({ code: 0 }),
    handleAddFriendResponse: async () => {}
  }), { code: 'APPROVAL_EXPIRED' })
  assert.equal(clicks, 0, 'a rejected or expired approval must abort before the click')
}

{
  const outcomes = []
  await assert.rejects(runApprovedNewChatAttempt({
    hooks: {
      newChatWillStartup: { promise: async () => {} },
      newChatAttempted: { promise: async () => {} },
      newChatOutcome: { promise: async (_context, outcome) => outcomes.push(outcome) }
    },
    page: { url: () => 'https://www.zhipin.com/web/geek/jobs' },
    targetJobData: job,
    startChatButtonProxy: { click: async () => { throw new Error('detached') } },
    waitForAddFriendResponse: async () => ({ code: 0 }),
    handleAddFriendResponse: async () => {}
  }), /detached/)
  assert.deepEqual(outcomes, ['failedPreAction'])
}

{
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = await fs.readFile(path.join(packageRoot, 'index.mjs'), 'utf8')
  assert(!source.includes('hooks.newChatWillStartup?.promise(targetJobData)'), 'the raw job hook must not bypass the context-gated send helper')
}

console.log('auto-chat safety hook check passed')
