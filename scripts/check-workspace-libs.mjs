/**
 * Report workspace packages whose built entry point is missing or stale.
 *
 * Several packages here depend on each other through `workspace:*`, which pnpm
 * links with a junction straight into the source directory. Their `main` and
 * `types` still point at `lib/`, which is gitignored. So editing `src` without
 * rebuilding makes the *consumer's* typecheck read the old bundle and fail with
 * a misleading error such as "has no exported member" for a symbol that clearly
 * exists in source.
 *
 * This check turns that into one actionable message. It is advisory: it only
 * inspects workspace links and compares modification times.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Recursively collect every source file that should precede a build. */
function newestSource(dir) {
  let newest = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
        stack.push(full)
        continue
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue
      const mtime = statSync(full).mtimeMs
      if (mtime > newest) newest = mtime
    }
  }
  return newest
}

/** Workspace package directories, by package name. */
function workspacePackages() {
  const packages = new Map()
  const packagesDir = join(root, 'packages')
  if (!existsSync(packagesDir)) return packages
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(packagesDir, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string') packages.set(manifest.name, { dir, manifest })
    } catch {
      // A malformed manifest is somebody else's error to report.
    }
  }
  return packages
}

/** Entry points a consumer resolves through the package `main`/`types` fields. */
function builtEntries(manifest) {
  const entries = []
  for (const field of ['main', 'types']) {
    const value = manifest[field]
    if (typeof value === 'string' && value !== '') entries.push(value)
  }
  return entries
}

const problems = []
for (const [name, { dir, manifest }] of workspacePackages()) {
  const built = builtEntries(manifest)
  if (built.length === 0) continue
  const sourceMtime = newestSource(join(dir, 'src'))
  if (sourceMtime === 0) continue
  for (const relative of built) {
    const target = join(dir, relative)
    if (!existsSync(target)) {
      problems.push({ name, relative, reason: 'missing' })
      continue
    }
    if (statSync(target).mtimeMs < sourceMtime) {
      problems.push({ name, relative, reason: 'stale' })
    }
  }
}

if (problems.length > 0) {
  process.stderr.write('Workspace builds are out of date:\n')
  for (const problem of problems) {
    process.stderr.write(`  ${problem.name}  ${problem.relative} is ${problem.reason}\n`)
  }
  const names = [...new Set(problems.map(problem => problem.name))]
  process.stderr.write(
    `\nRun "pnpm build" (or build ${names.join(', ')}) before typechecking.\n` +
    'Consumers resolve these packages through main/types, so an unbuilt src change\n' +
    'surfaces as a confusing "no exported member" error in the consuming package.\n',
  )
  process.exitCode = 1
}
