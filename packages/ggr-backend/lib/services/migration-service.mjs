import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const sqlitePluginRequire = createRequire(import.meta.resolve('@geekgeekrun/sqlite-plugin'))
const Database = sqlitePluginRequire('better-sqlite3')

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export async function migrateLegacyApprovalQueue({ queueFilePath, store, marker, records, fsOps = fs } = {}) {
  if (!queueFilePath || !store?.transaction || !marker?.id || !Array.isArray(records)) throw new TypeError('queueFilePath, store, marker, and records are required')
  const legacyQueue = await fsOps.readFile(queueFilePath, 'utf8').then(JSON.parse, (error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (!legacyQueue) return { migrated: false, backupPath: null }
  if (!Array.isArray(legacyQueue)) throw new Error('legacy approval queue must be an array')

  const imported = await store.transaction(async (tx) => {
    if (await tx.getApproval(marker.id)) return false
    for (const record of records) {
      if (!await tx.getApproval(record.id)) await tx.insertApproval(record)
    }
    await tx.insertApproval(marker)
    return true
  })
  const backupPath = `${queueFilePath}.migrated-${Date.now()}-${randomUUID()}.bak`
  await fsOps.rename(queueFilePath, backupPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
  await fsOps.chmod(backupPath, PRIVATE_FILE_MODE).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
  return { migrated: imported, backupPath }
}

function migrationError(code, message) { return Object.assign(new Error(message), { code }) }

async function sqliteBackup(source, destination, openDatabase) {
  const database = openDatabase(source, { readonly: true, fileMustExist: true })
  try { await database.backup(destination) } finally { database.close() }
  await fs.chmod(destination, PRIVATE_FILE_MODE)
}

export function createMigrationService({ stagingRoot, backupRoot, openDatabase = (filename, options) => new Database(filename, options) }) {
  if (!stagingRoot || !backupRoot) throw new TypeError('stagingRoot and backupRoot are required')

  async function rehearseMigrations({ sourceDb, candidateVersion, compatibility, runMigrations }) {
    if (!sourceDb || !candidateVersion || typeof runMigrations !== 'function') throw migrationError('INVALID_PARAMS', 'sourceDb, candidateVersion, and runMigrations are required')
    if (compatibility?.destructive && compatibility.previousVersionReadable !== true) {
      throw migrationError('MIGRATION_INCOMPATIBLE', 'Destructive migrations must remain readable by the previous version')
    }
    await fs.mkdir(stagingRoot, { recursive: true, mode: PRIVATE_DIR_MODE })
    await fs.chmod(stagingRoot, PRIVATE_DIR_MODE)
    const rehearsalDir = await fs.mkdtemp(path.join(stagingRoot, '.candidate-'))
    await fs.chmod(rehearsalDir, PRIVATE_DIR_MODE)
    const databaseFile = path.join(rehearsalDir, 'database.sqlite')
    try {
      await sqliteBackup(sourceDb, databaseFile, openDatabase)
      await runMigrations({ databaseFile, candidateVersion, compatibility: Object.freeze({ ...compatibility }) })
      return { candidateVersion, state: 'validated' }
    } finally {
      await fs.rm(rehearsalDir, { recursive: true, force: true })
    }
  }

  async function backupLiveDatabase({ sourceDb, version = 'current' } = {}) {
    if (!sourceDb) throw migrationError('INVALID_PARAMS', 'sourceDb is required')
    await fs.mkdir(backupRoot, { recursive: true, mode: PRIVATE_DIR_MODE })
    await fs.chmod(backupRoot, PRIVATE_DIR_MODE)
    const destination = path.join(backupRoot, `${version}-${Date.now()}-${randomUUID()}.sqlite`)
    await sqliteBackup(sourceDb, destination, openDatabase)
    return destination
  }

  return { rehearseMigrations, backupLiveDatabase }
}
