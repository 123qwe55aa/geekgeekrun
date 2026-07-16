import { execFile as execFileCallback } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = fileURLToPath(new URL('..', import.meta.url))

function options(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!['--output-dir', '--backend-artifact', '--manifest', '--signature'].includes(key)) throw new Error(`unknown argument: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
    values[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = path.resolve(value)
  }
  for (const key of ['outputDir', 'backendArtifact', 'manifest', 'signature']) {
    if (!values[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`)
  }
  return values
}

const config = options(process.argv.slice(2))
for (const input of [config.backendArtifact, config.manifest, config.signature]) {
  const info = await fs.lstat(input)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`release input must be a regular file: ${input}`)
}

const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-runtime-release-'))
try {
  const supervisor = path.join(staging, 'supervisor')
  await execFile(process.execPath, [path.join(root, 'scripts', 'build-ggrd-bootstrap.mjs')], {
    cwd: root,
    env: { ...process.env, GGRD_BOOTSTRAP_OUTPUT: supervisor }
  })
  await fs.mkdir(path.join(staging, 'backend'), { recursive: true, mode: 0o700 })
  await Promise.all([
    fs.copyFile(config.backendArtifact, path.join(staging, 'backend', path.basename(config.backendArtifact))),
    fs.copyFile(config.manifest, path.join(staging, 'backend', 'manifest.json')),
    fs.copyFile(config.signature, path.join(staging, 'backend', 'manifest.sig'))
  ])
  await fs.writeFile(path.join(staging, 'runtime-release.json'), `${JSON.stringify({
    format: 1,
    platform: process.platform,
    arch: process.arch,
    supervisor: 'supervisor',
    backend: { artifact: path.basename(config.backendArtifact), manifest: 'manifest.json', signature: 'manifest.sig' }
  }, null, 2)}\n`, { mode: 0o600 })
  await fs.rm(config.outputDir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(config.outputDir), { recursive: true })
  await fs.rename(staging, config.outputDir)
  console.log(`built GGR Runtime release at ${config.outputDir}`)
} catch (error) {
  await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  throw error
}
