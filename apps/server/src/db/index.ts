import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { Config } from '../config'
import { transaction } from './transaction'
import { createIdentityService } from './identity'

const initialSchema = readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8')

function requireRegularFile(file: string) {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (stat && (!stat.isFile() || stat.nlink !== 1)) {
    throw new Error('SQLite state requires an ordinary file without links.')
  }
}

function ensureDirectory(directory: string) {
  const stat = lstatSync(directory, { throwIfNoEntry: false })
  if (stat) {
    if (!stat.isDirectory() || realpathSync(directory) !== directory) {
      throw new Error('Symlinks in the private storage path are unsupported.')
    }
    return
  }
  ensureDirectory(path.dirname(directory))
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    ensureDirectory(directory)
  }
}

export function backupState(db: DatabaseSync, config: Pick<Config, 'dataDir'>, label = 'manual') {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid backup label.')
  const directory = path.join(config.dataDir, 'backups', 'database')
  ensureDirectory(directory)
  const name = `${new Date().toISOString().replaceAll(':', '-')}-${label}-${crypto.randomUUID()}.db`
  const file = path.join(directory, name)
  db.prepare('VACUUM INTO ?').run(file)
  chmodSync(file, 0o600)
  return file
}

export function openState(config: Config) {
  ensureDirectory(config.dataDir)
  const databasePath = path.join(config.dataDir, 'state.db')
  for (const suffix of ['', '-wal', '-shm', '-journal']) requireRegularFile(databasePath + suffix)
  const existing = existsSync(databasePath)
  const db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, allowExtension: false })
  try {
    chmodSync(databasePath, 0o600)
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
    if (version > 1) throw new Error('The database was created by a newer version of Synapse.')
    if (version === 0) {
      if (existing) backupState(db, config, 'before-migration')
      transaction(db, () => {
        // Another process may have finished initializing during the lock wait.
        if (db.prepare('PRAGMA user_version').get()?.user_version === 0) {
          db.exec(initialSchema)
          db.exec('PRAGMA user_version=1')
        }
      })
    }
    db.exec('PRAGMA journal_mode=WAL')
    const health = db.prepare('PRAGMA quick_check').get()
    if (health?.quick_check !== 'ok') throw new Error('SQLite integrity check failed. Restore a database backup before continuing.')
    transaction(db, () => {
      db.prepare("INSERT OR IGNORE INTO kv(key,value) VALUES('vault.path',?)").run(config.vaultPath)
      if (db.prepare("SELECT value FROM kv WHERE key='vault.path'").get()?.value !== config.vaultPath) {
        throw new Error('This data directory belongs to a different vault. Configure a separate dataDir for this vault.')
      }
    })
    const orm = drizzle(async (sql, params, method) => {
      const statement = db.prepare(sql)
      if (method === 'run') {
        statement.run(...params)
        return { rows: [] }
      }
      statement.setReturnArrays(true)
      const rows = method === 'get' ? statement.get(...params) : statement.all(...params)
      // node:sqlite types describe named rows even when setReturnArrays(true) is active.
      return { rows: rows as unknown as unknown[] }
    })
    return { db, orm, ...createIdentityService(db, config.courseHomeNote), close: () => db.close() }
  } catch (error) {
    db.close()
    throw error
  }
}

export type State = ReturnType<typeof openState>
