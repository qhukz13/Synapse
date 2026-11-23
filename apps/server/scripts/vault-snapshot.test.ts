import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { compareSnapshots, snapshotVault } from './vault-snapshot'

test('the independent snapshot catches content, timestamps, added files and removed files', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'synapse-snapshot-'))
  try {
    const root = path.join(sandbox, 'sample')
    await mkdir(root)
    await mkdir(path.join(root, '.venv'))
    const fixed = new Date('2020-01-01T00:00:00Z')
    for (const name of ['changed.md', 'touched.csv', 'removed.pdf']) {
      const target = path.join(root, name)
      await writeFile(target, 'one')
      await utimes(target, fixed, fixed)
    }
    await writeFile(path.join(sandbox, 'outside.txt'), 'Outside the root')
    await symlink(path.join(sandbox, 'outside.txt'), path.join(root, 'external.md'))
    await writeFile(path.join(root, '.venv', 'ignored.md'), 'Ignored')
    const before = await snapshotVault(root)
    expect(compareSnapshots(before, await snapshotVault(root))).toEqual({
      filesVerified: 3, created: 0, removed: 0, modified: 0,
    })
    const changed = path.join(root, 'changed.md')
    await writeFile(changed, 'two')
    await utimes(changed, fixed, fixed)
    await utimes(path.join(root, 'touched.csv'), fixed, new Date('2020-01-02T00:00:00Z'))
    await rm(path.join(root, 'removed.pdf'))
    await writeFile(path.join(root, 'created.ipynb'), '{}')
    expect(compareSnapshots(before, await snapshotVault(root))).toEqual({
      filesVerified: 3, created: 1, removed: 1, modified: 2,
    })
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})
