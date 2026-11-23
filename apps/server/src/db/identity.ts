import type { DatabaseSync } from 'node:sqlite'
import { ulid } from 'ulid'
import type { Source, Topic, VaultIndex } from '@synapse/core'
import { transaction } from './transaction'

type Origin = 'external' | 'app' | 'changeset'

interface Identity {
  nid: string
  node_key: string
  slug: string
  title: string
  kind: string
  content_hash: string
  last_status: string | null
  last_category: string | null
  deleted_at: number | null
}

const key = (node: Topic) => node.path.replace(/\.md$/i, '')

function shingles(body: string): Set<string> {
  const words = body.trim().toLowerCase().split(/\s+/u)
  const result = new Set<string>()
  for (let i = 2; i < words.length; i++) result.add(words.slice(i - 2, i + 1).join(' '))
  return result
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size < 8 || b.size < 8) return 0
  let overlap = 0
  for (const part of a) if (b.has(part)) overlap++
  return (2 * overlap) / (a.size + b.size)
}

/** Match only unique candidates in both directions; ambiguous moves remain detached. */
function renameMatches(
  added: Topic[], removed: Identity[], sources: ReadonlyMap<string, Source>, previousBodies: ReadonlyMap<string, string>,
): Map<string, Identity> {
  const scores: { node: Topic; row: Identity; score: number }[] = []
  const grams = new Map<string, Set<string>>()
  function gramsOf(content: string) {
    let result = grams.get(content)
    if (!result) {
      result = shingles(content)
      grams.set(content, result)
    }
    return result
  }
  for (const node of added) {
    const source = sources.get(node.path)!
    for (const row of removed) {
      let score = 0
      if (node.hash === row.content_hash) score = 3
      else if (node.title === row.title) score = 2
      else {
        const old = previousBodies.get(row.nid)
        if (old) score = similarity(gramsOf(old), gramsOf(source.text.slice(node.fm.bodyStart)))
      }
      if (score > 0.9) scores.push({ node, row, score })
    }
  }
  const matches = new Map<string, Identity>()
  for (const item of scores) {
    if (scores.some(other => other !== item &&
      (other.node === item.node || other.row.nid === item.row.nid) && other.score >= item.score)) continue
    matches.set(item.node.path, item.row)
  }
  return matches
}

export function createIdentityService(db: DatabaseSync, courseHomeNote: string) {
  let previousBodies = new Map<string, string>()
  const saveIdentity = db.prepare(`
    INSERT INTO node_identity(nid,node_key,slug,title,kind,content_hash,last_status,last_category,first_seen,last_seen,deleted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(nid) DO UPDATE SET
    node_key=excluded.node_key,slug=excluded.slug,title=excluded.title,kind=excluded.kind,
    content_hash=excluded.content_hash,last_status=excluded.last_status,last_category=excluded.last_category,
    last_seen=excluded.last_seen,deleted_at=NULL`)
  const recordEvent = db.prepare(`INSERT INTO status_event
    (nid,from_status,to_status,from_category,to_category,source,origin,at) VALUES(?,?,?,?,?,?,?,?)`)
  const ftsMap = db.prepare('SELECT rowid FROM fts_map WHERE nid=?')
  const mapDelete = db.prepare('DELETE FROM fts_map WHERE nid=?')
  const ftsInsert = db.prepare('INSERT INTO fts(rowid,title,headings,body) VALUES(?,?,?,?)')
  const mapInsert = db.prepare('INSERT INTO fts_map(nid,kind) VALUES(?,?)')
  function dropSearch(nid: string) {
    mapDelete.run(nid)
  }
  function search(query: string, limit = 100): string[] {
    const term = query.replaceAll('\0', ' ').trim()
    if (!term) return []
    const size = Math.max(1, Math.min(1000, Math.trunc(limit)))
    if (Array.from(term).length < 3) {
      return db.prepare('SELECT slug,title FROM node_identity WHERE deleted_at IS NULL ORDER BY title,slug')
        .all().filter(row => String(row.title).toLowerCase().startsWith(term.toLowerCase()))
        .slice(0, size).map(row => String(row.slug))
    }
    const phrase = '"' + term.replaceAll('"', '""') + '"'
    return db.prepare(`SELECT n.slug FROM fts JOIN fts_map m ON fts.rowid=m.rowid
      JOIN node_identity n ON n.nid=m.nid WHERE fts MATCH ? AND n.deleted_at IS NULL
      ORDER BY bm25(fts, 8, 3, 1),n.slug LIMIT ?`).all(phrase, size).map(row => String(row.slug))
  }
  function reconcile(index: VaultIndex, files: Source[], origin: Origin = 'external'): Map<string, string> {
    const seen = Date.now()
    const sources = new Map(files.map(f => [f.path, f]))
    if (index.nodes.some(node => !sources.has(node.path))) throw new Error('Cannot reconcile an incomplete source snapshot.')
    const bodies = new Map<string, string>()
    const ids = transaction(db, () => {
      const identities = db.prepare('SELECT * FROM node_identity').all() as unknown as Identity[]
      const known = new Map(identities.map(row => [row.node_key, row]))
      const currentKeys = new Set(index.nodes.map(key))
      const missing = identities.filter(row => !currentKeys.has(row.node_key))
      const movable = missing.filter(row => row.deleted_at === null || seen - row.deleted_at <= 3000)
      const renamed = renameMatches(index.nodes.filter(node => !known.has(key(node))), movable, sources, previousBodies)
      const ids = new Map<string, string>()
      const planned = index.nodes.map(node => {
        const row = known.get(key(node)) ?? renamed.get(node.path)
        const nid = row?.nid ?? ulid()
        ids.set(node.slug, nid)
        return { node, row, nid }
      })

      // Free former slugs together before resolving new deterministic collision suffixes.
      const retireSlug = db.prepare('UPDATE node_identity SET slug=? WHERE nid=?')
      for (const { node, row } of planned) {
        if (row && row.slug !== node.slug) retireSlug.run('@' + row.nid, row.nid)
      }
      const attached = new Set(ids.values())
      for (const row of missing) {
        if (attached.has(row.nid)) continue
        if (row.deleted_at === null) {
          db.prepare('UPDATE node_identity SET deleted_at=?,slug=? WHERE nid=?').run(seen, '@' + row.nid, row.nid)
          dropSearch(row.nid)
        }
        if (row.deleted_at === null || seen - row.deleted_at <= 3000) {
          const body = previousBodies.get(row.nid)
          if (body) bodies.set(row.nid, body)
        }
      }
      for (const { node, row, nid } of planned) {
        const file = sources.get(node.path)!
        const body = file.text.slice(node.fm.bodyStart)
        bodies.set(nid, body)
        const current = node.status.source === 'none' ? null : node.status.value
        const category = current === null ? null : node.status.category
        const moved = row && row.node_key !== key(node)
        if (moved) {
          db.prepare('INSERT OR REPLACE INTO node_alias(nid,old_key,renamed_at) VALUES(?,?,?)').run(nid, row.node_key, seen)
        }
        saveIdentity.run(nid, key(node), node.slug, node.title, node.kind, node.hash, current, category, seen, seen)
        if (row && current !== null && row.last_status !== current) {
          const observed = node.status.source === 'course-checkbox' ? sources.get(courseHomeNote)?.mtimeMs : file.mtimeMs
          const timestamp = origin === 'external' ? Math.trunc(observed ?? seen) : seen
          recordEvent.run(nid, row.last_status, current, row.last_category, category, node.status.source, origin, timestamp)
        }
        if (!row || row.deleted_at !== null || moved || row.content_hash !== node.hash || !ftsMap.get(nid)) {
          dropSearch(nid)
          const rowid = mapInsert.run(nid, node.kind).lastInsertRowid
          ftsInsert.run(rowid, node.title, node.sections.map(section => section.title).join('\n'), body)
        }
      }
      return ids
    })
    previousBodies = bodies
    return ids
  }
  return { reconcile, search }
}
