// Local developer utility. Only files explicitly listed in T1.1 are read.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function within(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

function selectedPaths(plan) {
  const line = plan.split('\n').find(text => text.startsWith('**T1.1 Fixture vault.**'))
  if (!line?.includes('Synthetic')) throw new Error('Missing T1.1 private fixture list in implementation plan.')
  const items = [...line.split('Synthetic')[0].matchAll(/`([^`]+)`/g)].map(match => match[1])
  const paths = items.flatMap(item => {
    const normalized = item.replace(/^…\//u, '01 - Foundations/Python Course/')
    const group = normalized.match(/^([^{}]+)\{([^{}]+)\}(\.md)$/)
    return group ? group[2].split(',').map(name => group[1] + name.trim() + group[3]) : [normalized]
  })
  if (!paths.length || new Set(paths).size !== paths.length ||
    paths.some(item => !/\.(md|ipynb)$/.test(item) || path.isAbsolute(item) ||
      item.split('/').some(part => !part || part.startsWith('.')) || /[\\\0]/.test(item))) {
    throw new Error('Private fixture list contains invalid or duplicate paths.')
  }
  return paths
}

async function privateDirectory(dir) {
  try {
    await mkdir(dir, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const info = await lstat(dir)
  if (!info.isDirectory() || (await realpath(dir)) !== dir || (info.mode & 0o077) !== 0) {
    throw new Error('Private fixture storage requires an owner-only directory without symlinks.')
  }
}

async function capture() {
  if (!process.argv[2]) throw new Error('Usage: node scripts/prepare-private-fixtures.mjs /path/to/vault [path/to/private/IMPLEMENTATION_PLAN.md]')
  const source = await realpath(process.argv[2])
  if (within(source, project) || within(project, source)) {
    throw new Error('The source vault and application checkout must be separate directories.')
  }
  const plan = await readFile(process.argv[3] || path.join(project, 'IMPLEMENTATION_PLAN.md'), 'utf8')
  const paths = selectedPaths(plan)
  const local = path.join(project, '.local')
  await mkdir(local, { recursive: true, mode: 0o700 })
  if (await realpath(local) !== local) throw new Error('The local runtime directory must be inside the checkout.')
  const storage = path.join(local, 'private-fixtures')
  await privateDirectory(storage)
  const staging = await mkdtemp(path.join(storage, '.capture-'))
  try {
    const records = []
    for (const rel of paths) {
      const from = path.join(source, rel)
      if (await realpath(from) !== from) throw new Error('Refusing to copy a symlink.')
      const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW)
      let content
      try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile()) throw new Error('The private fixture list must contain regular files.')
        content = await handle.readFile()
        const after = await lstat(from, { bigint: true })
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
          throw new Error('A source file changed during capture. Retry after synchronization.')
        }
      } finally {
        await handle.close()
      }
      const dest = path.join(staging, 'vault', rel)
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 })
      await writeFile(dest, content, { flag: 'wx', mode: 0o600 })
      const hash = digest(content)
      if (digest(await readFile(dest)) !== hash) throw new Error('Fixture copy verification failed.')
      records.push({ path: rel, sha256: hash, bytes: content.length })
    }
    const manifest = JSON.stringify(records, null, 2) + '\n'
    await writeFile(path.join(staging, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 })
    const id = digest(manifest)
    const snapshot = path.join(storage, id)
    try {
      await rename(staging, snapshot)
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
      if (await realpath(snapshot) !== snapshot || await readFile(path.join(snapshot, 'manifest.json'), 'utf8') !== manifest) {
        throw new Error('A different snapshot already exists at that location.')
      }
      for (const {path: rel, sha256} of records) {
        const file = path.join(snapshot, 'vault', rel)
        if (await realpath(file) !== file || digest(await readFile(file)) !== sha256) throw new Error('The existing private copy has changed.')
      }
    }
    console.log(`Verified ${records.length} byte-exact files in ${path.relative(project, snapshot)}/vault`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

capture().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
