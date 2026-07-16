import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

assert.match(
  source,
  /response\.url\(\)\.startsWith\('https:\/\/www\.zhipin\.com\/wapi\/zpgeek\/job\/detail\.json'\)\s*&&\s*response\.request\(\)\.method\(\) === 'GET'/,
  'the job-detail listener must ignore OPTIONS preflight responses before reading their body'
)

console.log('preflight response check passed')
