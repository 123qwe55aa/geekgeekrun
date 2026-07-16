import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function parse(argv) {
  const values = { home: os.homedir() }
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!['--release-dir', '--home'].includes(key)) throw new Error(`unknown argument: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
    values[key === '--release-dir' ? 'releaseDirectory' : 'home'] = path.resolve(value)
  }
  if (!values.releaseDirectory) throw new Error('--release-dir is required')
  return values
}

const options = parse(process.argv.slice(2))
const metadata = JSON.parse(await fs.readFile(path.join(options.releaseDirectory, 'runtime-release.json'), 'utf8'))
if (metadata?.format !== 1 || metadata.platform !== process.platform || metadata.arch !== process.arch) throw new Error('Runtime release is incompatible with this machine')
const supervisor = path.resolve(options.releaseDirectory, metadata.supervisor)
const backend = path.resolve(options.releaseDirectory, 'backend')
if (!supervisor.startsWith(`${options.releaseDirectory}${path.sep}`) || !backend.startsWith(`${options.releaseDirectory}${path.sep}`)) throw new Error('Runtime release paths are unsafe')
await Promise.all([fs.access(path.join(supervisor, 'server.mjs')), fs.access(path.join(backend, 'manifest.json')), fs.access(path.join(backend, 'manifest.sig'))])

const { createVersionStore } = await import(pathToFileURL(path.join(supervisor, 'lib', 'version-store.mjs')).href)
const { createLocalReleaseService } = await import(pathToFileURL(path.join(supervisor, 'lib', 'release-service.mjs')).href)
const { createMigrationService } = await import(pathToFileURL(path.join(supervisor, 'lib', 'migration-service.mjs')).href)
const { installLaunchdSupervisor } = await import(pathToFileURL(path.join(supervisor, 'lib', 'launchd.mjs')).href)
const runtimeDirectory = path.join(options.home, '.geekgeekrun')
const versionStore = createVersionStore(runtimeDirectory)
const service = createLocalReleaseService({ versionStore, releaseDirectory: backend, migrationService: createMigrationService({ runtimeDir: runtimeDirectory }) })
const manifest = await service.checkForUpdates()
if (!await versionStore.current()) {
  const installation = await service.install()
  await versionStore.activate(installation.version)
}
await installLaunchdSupervisor({
  homeDirectory: options.home,
  bootstrapSource: supervisor,
  bootstrapVersion: `runtime-${manifest.version}`
})
console.log(`GGR Runtime installed; backend ${await versionStore.current()}`)
