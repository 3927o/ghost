/** Keep the business backend and public protocol independent from Agent implementation details. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const packages = new Map<string, string>()
for (const group of ['apps', 'packages']) {
  for (const directory of readdirSync(join(root, group))) {
    const path = join(root, group, directory)
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
    packages.set(manifest.name, path)
  }
}

test('API, public contracts and queue imports cannot cross into DSH or Worker', () => {
  const checked = new Set<string>()
  const visit = (file: string) => {
    if (checked.has(file)) return
    checked.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const name = match[1]
      assert.ok(!name.startsWith('@deepseek-ai/'), `${file} imports runtime package ${name}`)
      if (name.startsWith('.') || [...packages.keys()].some(pkg => name === pkg || name.startsWith(pkg + '/'))) {
        const target = name.startsWith('.') ? resolve(dirname(file), name) : fileURLToPath(import.meta.resolve(name))
        assert.ok(!target.includes('/apps/agent-worker/'), `${file} imports Worker implementation ${target}`)
        visit(target)
      }
    }
  }
  for (const entry of ['apps/api/main.ts', 'packages/contracts/index.ts', 'packages/queue/index.ts']) visit(join(root, entry))
})

test('Redis transport is standalone and Agent runtime cannot import business repositories', () => {
  const queueManifest = JSON.parse(readFileSync(join(root, 'packages/queue/package.json'), 'utf8'))
  assert.ok(Object.keys(queueManifest.dependencies).every(name => !name.startsWith('@ghost/')))
  for (const file of ['packages/queue/index.ts', 'apps/agent-worker/runtime/index.ts']) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.ok(!source.includes('@ghost/database'), `${file} imports business persistence`)
  }
})
