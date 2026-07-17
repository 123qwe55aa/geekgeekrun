import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const repository = fileURLToPath(new URL('../..', import.meta.url))
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ggr-runtime-release-check-'))
const artifact = path.join(temporary, 'ggr-backend-1.0.1-darwin-arm64.tar.gz')
const manifest = path.join(temporary, 'manifest.json')
const signature = path.join(temporary, 'manifest.sig')
const release = path.join(temporary, 'release')
const app = path.join(temporary, 'app')

try {
  await Promise.all([
    fs.writeFile(artifact, 'test backend artifact'),
    fs.writeFile(manifest, '{}\n'),
    fs.writeFile(signature, 'test signature\n')
  ])
  await execFile(process.execPath, [
    'scripts/build-ggr-runtime-release.mjs', '--output-dir', release,
    '--backend-artifact', artifact, '--manifest', manifest, '--signature', signature
  ], { cwd: repository })

  const metadata = JSON.parse(await fs.readFile(path.join(release, 'runtime-release.json'), 'utf8'))
  assert.equal(metadata.bootstrapVersion, 'ggrd-1.0.1', 'Runtime must identify ggrd independently from the backend version')
  const bootstrap = JSON.parse(await fs.readFile(path.join(release, 'supervisor', 'package.json'), 'utf8'))
  assert.equal(bootstrap.version, '1.0.1', 'Runtime must embed the selected ggrd bootstrap version')
  const trustRoot = await fs.readFile(path.join(release, 'supervisor', 'lib', 'trust-root.mjs'), 'utf8')
  assert.match(trustRoot, /123qwe55aa\/geekgeekrun/, 'Runtime must use this repository as its signed update source')

  await execFile(process.execPath, ['scripts/build-ggr-runtime-app.mjs', '--release-dir', release, '--output-dir', app], { cwd: repository })
  const infoPlist = await fs.readFile(path.join(app, 'GGR Runtime.app', 'Contents', 'Info.plist'), 'utf8')
  const launcher = await fs.readFile(path.join(app, 'GGR Runtime.app', 'Contents', 'MacOS', 'GGR Runtime'), 'utf8')
  assert.match(infoPlist, /<key>CFBundleShortVersionString<\/key><string>1\.0\.1<\/string>/, 'Runtime app version must follow ggrd')
  assert.match(launcher, /display dialog "GGR Runtime 已安装并在后台运行/, 'Runtime app must acknowledge successful installation')
  assert.match(launcher, /display dialog "GGR Runtime 安装失败/, 'Runtime app must surface installation failures')
  assert.match(launcher, /runtime-installer\.log/, 'Runtime app must persist installer failures for diagnosis')
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}

console.log('ggr Runtime release check passed')
