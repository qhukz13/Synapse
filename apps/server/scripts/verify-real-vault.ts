// Read-only entry point. Never boot the server, initialize SQLite or load write services here.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildIndex } from '@synapse/core'
import { scanVault } from '../src/vault/scanner'
import { compareSnapshots, snapshotVault } from './vault-snapshot'

const baseline = {
  markdown: 194, frontmatters: 166, invalidFrontmatters: 0,
  concepts: 104, projects: 9, lessons: 13, courseProjects: 9,
  notebooks: 20, pdfs: 8, csvs: 1, distinctUrls: 280,
  prerequisiteEdges: 162, curriculumPrerequisites: 145, learningStages: 12,
  sourceFrontmatter: 166, sourceCheckbox: 16, sourceNone: 12,
}

// Two discovery figures have a different scope or have drifted on disk. Keep both visible.
const baselineReconciliation = {
  pdfs: { discovery: 9, verified: 8, reason: 'The current vault has seven book PDFs and one data PDF.' },
  distinctUrls: { discovery: 279, verified: 280, reason: 'Discovery counted Markdown-link URLs. The GFM index also includes one distinct bare URL.' },
}

const expectedIssues: Record<string, number> = {
  'link.folder': 3, 'prereq.bodyOnly': 6, 'frontmatter.missing': 28,
  'prereq.laterInPath': 8, 'prereq.redundant': 33, 'note.orphan': 3,
  'concept.noPrimaryResource': 3, 'domain.catchAll': 13,
}

async function verify() {
  const { values } = parseArgs({ options: {
    vault: { type: 'string' },
    'inventory-only': { type: 'boolean', default: false },
  } })
  const sibling = fileURLToPath(new URL('../../../../Learning-ML-AI/AI-ML-Vault/', import.meta.url))
  const root = path.resolve(values.vault || process.env.SYNAPSE_VERIFY_VAULT || sibling)
  const before = await snapshotVault(root)
  let failure: unknown
  try {
    const scan = await scanVault(root)
    const index = buildIndex(scan.files, {
      library: scan.library.map(file => file.path), conflicts: scan.conflicts, unsafe: scan.unsafe,
    })
    const nodes = index.nodes
    const kinds = (kind: string) => nodes.filter(node => node.kind === kind).length
    const sources = (source: string) => nodes.filter(node => node.status.source === source).length
    const extension = (ext: string) => scan.library.filter(file => path.extname(file.path).toLowerCase() === ext).length
    const bySlug = new Map(nodes.map(node => [node.slug, node]))
    const inventory: typeof baseline = {
      markdown: nodes.length,
      frontmatters: nodes.filter(node => node.fm.present).length,
      invalidFrontmatters: nodes.filter(node => node.fm.error).length,
      concepts: kinds('concept'), projects: kinds('project'), lessons: kinds('lesson'),
      courseProjects: kinds('course-project'), notebooks: extension('.ipynb'), pdfs: extension('.pdf'),
      csvs: extension('.csv'), distinctUrls: new Set(nodes.flatMap(node => node.resources.map(res => res.url))).size,
      prerequisiteEdges: index.edges.length,
      curriculumPrerequisites: index.edges.filter(edge => bySlug.get(edge.from)?.kind !== 'note').length,
      learningStages: index.learningPath.stages.length,
      sourceFrontmatter: sources('frontmatter'), sourceCheckbox: sources('course-checkbox'), sourceNone: sources('none'),
    }
    const issueCounts: Record<string, number> = {}
    for (const issue of index.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1
    console.log(JSON.stringify({ inventory, issueCounts, ...(!values['inventory-only'] && {baselineReconciliation}) }, null, 2))
    if (!values['inventory-only']) {
      const differences: string[] = []
      for (const key of Object.keys(baseline) as Array<keyof typeof baseline>) {
        if (inventory[key] !== baseline[key]) differences.push(`${key}: expected ${baseline[key]}, observed ${inventory[key]}`)
      }
      for (const code of new Set([...Object.keys(expectedIssues), ...Object.keys(issueCounts)])) {
        const expected = expectedIssues[code] ?? 0
        const observed = issueCounts[code] ?? 0
        if (expected !== observed) differences.push(`${code}: expected ${expected}, observed ${observed}`)
      }
      if (differences.length > 0) throw new Error('Discovery baseline differs:\n' + differences.join('\n'))
    }
  } catch (error) {
    failure = error
  }
  const changes = compareSnapshots(before, await snapshotVault(root))
  console.log(JSON.stringify({ integrity: changes }))
  if (changes.created || changes.removed || changes.modified) throw new Error('Files changed during read-only verification.')
  if (failure) throw failure
}

verify().catch((error: unknown) => {
  // Filesystem errors can contain private paths. Print only the operation and code.
  if (error instanceof Error && 'syscall' in error && 'code' in error) console.error('Verification failed:', error.syscall, error.code)
  else console.error(error instanceof Error ? error.message : 'Verification failed')
  process.exitCode = 1
})
