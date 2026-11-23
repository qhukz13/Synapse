import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildIndex, type Source } from '@synapse/core'
import { configFrom } from '../config'
import { backupState, openState, type State } from './index'
import { transaction } from './transaction'

const sandboxes: string[] = []
const stores: State[] = []
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'synapse-state-'))
  sandboxes.push(root)
  const config = configFrom({ vaultPath: path.join(root, 'vault'), dataDir: path.join(root, 'data') })
  const start = () => {
    const state = openState(config)
    stores.push(state)
    return state
  }
  return { root, config, start }
}
afterEach(() => {
  for (const state of stores.splice(0)) if (state.db.isOpen) state.close()
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true })
})

const secret = 'Мятный фонарь показывает температуру утреннего тумана.'
function source(path: string, status = 'unread', body = secret): Source {
  const text = `---\ntype: concept\ndomain: programming\ndifficulty: beginner\nimportance: high\nstatus: ${status}\nprerequisites: []\n---\n\n## Observations\n\n${body}\n`
  return { path, text, hash: createHash('sha256').update(text).digest('hex'), mtimeMs: 100_000 }
}
const reconcile = (state: State, ...files: Source[]) => state.reconcile(buildIndex(files), files)

test('activity and search survive restart; external status changes are recorded exactly once', () => {
  const fixtureState = fixture()
  const first = fixtureState.start()
  const file = source('Topics/Пример.md')
  const initial = reconcile(first, file)
  const [[slug, id]] = Array.from(initial) as [[string, string]]
  first.db.prepare("INSERT INTO study_session(id,nid,state,started_at) VALUES('s',?,'ended',100)").run(id)
  expect(first.search('фонарь')).toEqual([slug])
  expect(first.search('пр')).toEqual([slug])
  expect(first.search('дельфин')).toEqual([])
  expect(first.db.prepare('SELECT body FROM fts').get()?.body).toBeNull()
  first.close()
  expect(readFileSync(path.join(fixtureState.config.dataDir, 'state.db')).includes(Buffer.from(secret))).toBe(false)
  const next = fixtureState.start()
  const edited = source(file.path, 'learning', 'Синяя лампа показывает новый результат.')
  reconcile(next, edited)
  reconcile(next, edited)
  expect(next.search('фонарь')).toEqual([])
  expect(next.search('лампа')).toEqual([slug])
  expect(next.db.prepare('SELECT nid FROM study_session').get()?.nid).toBe(id)
  expect(next.db.prepare('SELECT nid,from_status,to_status,origin,at FROM status_event').all()).toEqual([
    { nid: id, from_status: 'unread', to_status: 'learning', origin: 'external', at: 100000 },
  ])
})

test('separate unlink/add events preserve identity, old path and activity after an exact-content rename', () => {
  const { start } = fixture()
  const state = start()
  const from = source('Old/Initial.md')
  const [id] = reconcile(state, from).values()
  state.db.prepare("INSERT INTO review_item(id,nid,state,created_at) VALUES('r',?,'queued',1)").run(id!)
  reconcile(state)
  expect(state.search('фонарь')).toEqual([])
  const to = { ...from, path: 'New/Renamed.md' }
  expect([...reconcile(state, to).values()]).toEqual([id])
  expect(state.search('фонарь')).toEqual(['renamed'])
  expect(state.db.prepare('SELECT old_key FROM node_alias').all()).toEqual([{ old_key: 'Old/Initial' }])
  expect(state.db.prepare('SELECT nid FROM review_item').get()?.nid).toBe(id)
})

test('same basename and highly similar bodies are used only when the move is unambiguous', () => {
  const state = fixture().start()
  const body = Array.from({ length: 200 }, (_, i) => 'measurement-' + i).join(' ')
  const a = source('Old/Calibration.md', 'unread', body)
  const b = source('Old/Evaluation.md', 'unread', 'Original text for the other example.')
  const old = reconcile(state, a, b)
  const moved = reconcile(state, source('New/Calibration.md', 'unread', 'Entirely different text'),
    source('Other/Renamed.md', 'unread', body), source('New/Evaluation.md', 'unread', 'A new input.'))
  // Exact content is stronger evidence than a conflicting basename match.
  expect(moved.get('renamed')).toBe(old.get('calibration'))
  expect(moved.get('evaluation')).toBe(old.get('evaluation'))
  expect(moved.get('calibration')).not.toBe(old.get('calibration'))
  const again = reconcile(state, source('Third/With edits.md', 'unread', body + ' A short addition.'))
  expect(again.get('with-edits')).toBe(moved.get('renamed'))
})

test('ambiguous content matches retain detached records without attaching history to a different topic', () => {
  const state = fixture().start()
  const prior = reconcile(state, source('A.md'))
  const next = reconcile(state, source('B.md'), source('C.md'))
  expect([...next.values()]).not.toContain(prior.get('a'))
  expect(state.db.prepare('SELECT count(*) AS n FROM node_identity WHERE deleted_at IS NOT NULL').get()?.n).toBe(1)
})

test('slug collision changes preserve nids when folder ordering changes', () => {
  const state = fixture().start()
  const keep = source('B/Dup.md')
  const other = source('A/Dup.md', 'unread', 'Other')
  const initial = reconcile(state, keep)
  const two = reconcile(state, keep, other)
  expect(two.get('dup-2')).toBe(initial.get('dup'))
  const one = reconcile(state, keep)
  expect(one.get('dup')).toBe(initial.get('dup'))
})

test('migration is idempotent and SQLite enforces one open timer and one queued review', async () => {
  const fixtureState = fixture()
  const state = fixtureState.start()
  const [id] = reconcile(state, source('Model.md')).values()
  const timer = state.db.prepare("INSERT INTO study_session(id,nid,state,started_at) VALUES(?,?,'running',100)")
  timer.run('s1', id!)
  expect(() => timer.run('s2', id!)).toThrow()
  const review = state.db.prepare("INSERT INTO review_item(id,nid,state,created_at) VALUES(?,?,'queued',100)")
  review.run('r1', id!)
  expect(() => review.run('r2', id!)).toThrow()
  expect(await state.orm.values(sql`SELECT state FROM review_item`)).toEqual([['queued']])
  const backup = backupState(state.db, fixtureState.config)
  const restored = new DatabaseSync(backup, {readOnly: true})
  try {
    expect(restored.prepare('SELECT id FROM study_session').get()?.id).toBe('s1')
    expect(restored.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
  } finally {
    restored.close()
  }
  expect(() => transaction(state.db, () => {
    state.db.exec("INSERT INTO kv VALUES('partial','test')")
    throw new Error('cancel')
  })).toThrow('cancel')
  expect(state.db.prepare("SELECT value FROM kv WHERE key='partial'").get()).toBeUndefined()
})

test('state rejects links and a mismatched vault binding before reconciling any files', () => {
  const { root, config, start } = fixture()
  mkdirSync(config.dataDir)
  const protectedFile = path.join(root, 'untouched')
  writeFileSync(protectedFile, 'original')
  const target = path.join(config.dataDir, 'state.db')
  symlinkSync(protectedFile, target)
  expect(() => start()).toThrow(/ordinary file/)
  expect(readFileSync(protectedFile, 'utf8')).toBe('original')
  rmSync(target)
  start().close()
  expect(() => openState({ ...config, vaultPath: path.join(root, 'another-vault') })).toThrow(/different vault/)
})


test('a linked backup directory cannot create a folder outside app storage', () => {
  const {root, config, start} = fixture()
  const state = start()
  const outside = path.join(root, 'elsewhere')
  mkdirSync(outside)
  symlinkSync(outside, path.join(config.dataDir, 'backups'))
  expect(() => backupState(state.db, config)).toThrow(/Symlinks/)
  expect(existsSync(path.join(outside, 'database'))).toBe(false)
})
