import fs from 'node:fs/promises'
import path from 'node:path'

function parse(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (key !== '--release-dir' && key !== '--output-dir') throw new Error(`unknown argument: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
    values[key === '--release-dir' ? 'releaseDirectory' : 'outputDirectory'] = path.resolve(value)
  }
  if (!values.releaseDirectory || !values.outputDirectory) throw new Error('--release-dir and --output-dir are required')
  return values
}

const options = parse(process.argv.slice(2))
const app = path.join(options.outputDirectory, 'GGR Runtime.app')
const contents = path.join(app, 'Contents')
const resources = path.join(contents, 'Resources')
const macos = path.join(contents, 'MacOS')
const metadata = JSON.parse(await fs.readFile(path.join(options.releaseDirectory, 'runtime-release.json'), 'utf8'))
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(metadata.bootstrapVersion ?? '')) throw new Error('Runtime release has an invalid supervisor bootstrap version')
const runtimeVersion = metadata.bootstrapVersion.replace(/^ggrd-/, '')
await fs.rm(app, { recursive: true, force: true })
await fs.mkdir(resources, { recursive: true, mode: 0o700 })
await fs.mkdir(macos, { recursive: true, mode: 0o700 })
await fs.cp(options.releaseDirectory, path.join(resources, 'runtime-release'), { recursive: true, dereference: true })
await fs.copyFile(path.resolve('scripts/install-ggr-runtime.mjs'), path.join(resources, 'install-ggr-runtime.mjs'))
await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>GGR Runtime</string><key>CFBundleExecutable</key><string>GGR Runtime</string><key>CFBundleIdentifier</key><string>com.geekgeekrun.runtime</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${runtimeVersion}</string></dict></plist>\n`)
const launcher = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
NODE="$ROOT/Resources/runtime-release/supervisor/runtime/bin/node"
INSTALLER="$ROOT/Resources/install-ggr-runtime.mjs"
RELEASE="$ROOT/Resources/runtime-release"
if "$NODE" "$INSTALLER" --release-dir "$RELEASE"; then
  /usr/bin/osascript -e 'display dialog "GGR Runtime 已安装并在后台运行。你现在可以打开 GeekGeekRun。" with title "GGR Runtime" buttons {"完成"} default button "完成"' || true
else
  /usr/bin/osascript -e 'display dialog "GGR Runtime 安装失败。请在 GeekGeekRun 的设置页查看诊断信息。" with title "GGR Runtime" buttons {"完成"} default button "完成" with icon stop' || true
  exit 1
fi
`
const launcherPath = path.join(macos, 'GGR Runtime')
await fs.writeFile(launcherPath, launcher, { mode: 0o755 })
console.log(`built ${app}`)
