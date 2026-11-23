// Independent witness for the verifier. This module has no dependencies on the indexer.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

const ignoredDirectories = new Set([
  '.git', '.obsidian', '.stfolder', '.stversions', '.trash',
  '.venv', 'node_modules', '.ipynb_checkpoints', '.jupyter',
])

interface FileStamp {
  digest: string
  mtimeNs: bigint
  size: bigint
}

type Snapshot = Map<string, FileStamp>

async function stamp(absolute: string): Promise<FileStamp> {
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) throw new Error('The selected entry is no longer a regular file.')
    const hash = createHash('sha256')
    for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes)
    const after = await lstat(absolute, { bigint: true })
    if (before.ino !== after.ino || before.dev !== after.dev || before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error('A file changed while the verification snapshot was being read.')
    }
    return { digest: hash.digest('hex'), mtimeNs: before.mtimeNs, size: before.size }
  } finally {
    await file.close()
  }
}

export async function snapshotVault(root: string): Promise<Snapshot> {
  const canonical = await realpath(root)
  const snapshot: Snapshot = new Map()
  async function walk(relative: string) {
    const dir = path.join(canonical, relative)
    if (await realpath(dir) !== dir) throw new Error('A directory changed to a symlink during verification.')
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await walk(child)
        continue
      }
      if (!entry.isFile() || /\.synapse-tmp-|^(?:\.syncthing\.|~syncthing~).*\.tmp$/i.test(entry.name)) continue
      snapshot.set(child, await stamp(path.join(canonical, child)))
    }
  }
  await walk('')
  return snapshot
}

export function compareSnapshots(before: Snapshot, after: Snapshot) {
  let created = 0
  let removed = 0
  let modified = 0
  for (const [name, old] of before) {
    const current = after.get(name)
    if (!current) removed++
    else if (old.digest !== current.digest || old.mtimeNs !== current.mtimeNs || old.size !== current.size) modified++
  }
  for (const name of after.keys()) if (!before.has(name)) created++
  return { filesVerified: before.size, created, removed, modified }
}
