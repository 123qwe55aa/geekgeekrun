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
await fs.access(path.join(options.releaseDirectory, 'runtime-release.json'))
await fs.rm(app, { recursive: true, force: true })
await fs.mkdir(resources, { recursive: true, mode: 0o700 })
await fs.mkdir(macos, { recursive: true, mode: 0o700 })
await fs.cp(options.releaseDirectory, path.join(resources, 'runtime-release'), { recursive: true, dereference: true })
await fs.copyFile(path.resolve('scripts/install-ggr-runtime.mjs'), path.join(resources, 'install-ggr-runtime.mjs'))
await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>GGR Runtime</string><key>CFBundleExecutable</key><string>GGR Runtime</string><key>CFBundleIdentifier</key><string>com.geekgeekrun.runtime</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0.0</string></dict></plist>\n`)
const launcher = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$ROOT/Resources/runtime-release/supervisor/runtime/bin/node" "$ROOT/Resources/install-ggr-runtime.mjs" --release-dir "$ROOT/Resources/runtime-release"
`
const launcherPath = path.join(macos, 'GGR Runtime')
await fs.writeFile(launcherPath, launcher, { mode: 0o755 })
console.log(`built ${app}`)
