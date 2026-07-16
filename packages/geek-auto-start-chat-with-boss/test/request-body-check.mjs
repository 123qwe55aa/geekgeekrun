import assert from 'node:assert/strict'

import { requestPostDataOrEmpty } from '../request-utils.mjs'

assert.equal(requestPostDataOrEmpty({ postData: () => 'code=41&securityId=job-1' }), 'code=41&securityId=job-1')
assert.equal(
  requestPostDataOrEmpty({ postData: () => { throw new Error('Could not load body for this request. This might happen if the request is a preflight request.') } }),
  ''
)

console.log('request body check passed')
