import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { loadConfig, parseRef, preparePayload, shellQuote, validateRef, validateSource } from '../scripts/deploy.ts'

const exec = promisify(execFile)
const project = resolve(import.meta.dirname, '..')
const values = {
  DEPLOY_HOST: 'deployment-target', DEPLOY_PATH: '/srv/application',
  DEPLOY_SERVICES: 'application@api.service application@agent-worker.service',
  DEPLOY_HEALTH_URL: 'http://127.0.0.1:3000/api/health',
}
async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), 'deploy-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('external configuration, ref parsing and shell quoting reject unsafe input', async t => {
  const directory = await temporary(t)
  await writeFile(join(directory, '.deploy.env'), Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'))
  const before = process.env.DEPLOY_HOST
  assert.equal(loadConfig(directory, {}).host, values.DEPLOY_HOST)
  assert.equal(loadConfig(directory, { DEPLOY_HOST: 'ci-target' }).host, 'ci-target')
  assert.equal(process.env.DEPLOY_HOST, before)
  for (const [key, value] of [
    ['DEPLOY_HOST', '-oProxyCommand=private'], ['DEPLOY_PATH', '/'], ['DEPLOY_PATH', '/srv/../private'],
    ['DEPLOY_SERVICES', '--private.service'], ['DEPLOY_HEALTH_URL', 'http://user:private@localhost'],
  ]) assert.throws(() => loadConfig(directory, { [key]: value }), error => !String(error).includes('private'))
  assert.equal(parseRef([]), 'HEAD')
  for (const ref of ['abc1234', 'v1.0', 'origin/main', 'HEAD~1']) assert.equal(parseRef(['--ref', ref]), ref)
  for (const args of [['--ref'], ['--ref', '--all'], ['--rollback']]) assert.throws(() => parseRef(args), /Usage/)
  const literal = "/tmp/application ' space $HOME ; $(false)"
  assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(literal)}`], { encoding: 'utf8' }), literal)
})

test('packaging an older commit ignores HEAD, local edits, root secrets and untracked files', async t => {
  const directory = await temporary(t)
  const repo = join(directory, 'repo'), work = join(directory, 'work')
  await mkdir(join(repo, 'apps/web'), { recursive: true })
  await mkdir(join(repo, 'packages/example'), { recursive: true })
  await mkdir(work)
  for (const file of ['apps/api/main.ts', 'apps/api/package.json', 'apps/agent-worker/main.ts', 'apps/agent-worker/package.json',
    'packages/config/index.ts', 'packages/database-client/index.ts', 'packages/database-client/drivers/postgres.ts']) {
    await mkdir(resolve(repo, file, '..'), { recursive: true }); await writeFile(join(repo, file), file.endsWith('.json') ? '{}' : '')
  }
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, workspaces: ['apps/*', 'packages/*'], scripts: { 'build:web': 'node apps/web/build.cjs' } }))
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'vite.config.ts'), '')
  await writeFile(join(repo, '.env'), 'PRIVATE')
  await writeFile(join(repo, '.deploy.env'), 'PRIVATE')
  await writeFile(join(repo, 'packages/example/index.ts'), 'old-commit')
  await writeFile(join(repo, 'apps/web/build.cjs'), "const fs=require('node:fs');fs.mkdirSync('dist/web',{recursive:true});fs.writeFileSync('dist/web/index.html',fs.readFileSync('packages/example/index.ts'));")
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'fixture')
  git('init', '-q'); git('add', '.'); commit()
  const selected = git('rev-parse', 'HEAD')
  await writeFile(join(repo, 'packages/example/index.ts'), 'new-commit'); commit()
  await writeFile(join(repo, 'packages/example/index.ts'), 'uncommitted')
  await writeFile(join(repo, 'apps/web/untracked.txt'), 'PRIVATE')
  const archive = await preparePayload(repo, work, selected)
  const unpacked = join(directory, 'unpacked')
  await mkdir(unpacked)
  execFileSync('tar', ['-xzf', archive, '-C', unpacked])
  assert.equal(await readFile(join(unpacked, 'packages/example/index.ts'), 'utf8'), 'old-commit')
  assert.equal(await readFile(join(unpacked, 'dist/web/index.html'), 'utf8'), 'old-commit')
  for (const path of ['.env', '.deploy.env', 'node_modules', 'apps/web/untracked.txt']) {
    await assert.rejects(lstat(join(unpacked, path)), { code: 'ENOENT' })
  }
  assert.ok(!execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).includes('._'))
  await writeFile(join(unpacked, 'apps/.env'), 'PRIVATE')
  await assert.rejects(validateSource(unpacked), /private, generated, or linked/)
  await rm(join(unpacked, 'apps/.env'))
  await symlink('/outside', join(unpacked, 'apps/link'))
  await assert.rejects(validateSource(unpacked), /private, generated, or linked/)
})

test('monolith and SQLite-only worker commits are refused before building', async t => {
  const repo = await temporary(t)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture') }
  git('init', '-q')
  await writeFile(join(repo, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'], scripts: { 'build:web': 'vite build' } }))
  commit()
  assert.throws(() => validateRef(repo, 'HEAD'), /Unsupported commit/)
  for (const file of ['apps/api/main.ts', 'apps/api/package.json', 'apps/agent-worker/main.ts', 'apps/agent-worker/package.json',
    'packages/config/index.ts', 'package-lock.json', 'vite.config.ts']) {
    await mkdir(resolve(repo, file, '..'), { recursive: true }); await writeFile(join(repo, file), '')
  }
  commit()
  assert.throws(() => validateRef(repo, 'HEAD'), /Unsupported commit/)
  for (const file of ['packages/database-client/index.ts', 'packages/database-client/drivers/postgres.ts']) {
    await mkdir(resolve(repo, file, '..'), { recursive: true }); await writeFile(join(repo, file), '')
  }
  commit()
  assert.doesNotThrow(() => validateRef(repo, 'HEAD'))
})

test('remote deployment preserves state, removes stale code, locks updates and reports installation failure', async t => {
  const directory = await temporary(t)
  const app = join(directory, "application ' directory"), payload = join(directory, 'payload'), bin = join(directory, 'bin')
  for (const path of [app, bin, join(app, 'data'), join(app, 'apps'), join(payload, 'apps'), join(payload, 'packages'), join(payload, 'dist')]) await mkdir(path, { recursive: true })
  await writeFile(join(app, '.env'), 'PRIVATE', { mode: 0o600 })
  await writeFile(join(app, 'data/record'), 'persistent')
  await writeFile(join(app, 'apps/stale.ts'), 'obsolete')
  await writeFile(join(app, 'notes.txt'), 'unmanaged')
  await writeFile(join(payload, 'apps/new.ts'), 'new-code')
  for (const name of ['package.json', 'package-lock.json']) await writeFile(join(payload, name), '{}')
  const archive = join(directory, 'payload.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', payload, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const programs: Record<string, string> = {
    id: '#!/bin/sh\necho 0\n',
    flock: `#!${process.execPath}\nrequire('node:fs').fstatSync(9);process.exit(process.env.LOCK_BUSY==='1'?1:0);\n`,
    systemctl: '#!/bin/sh\nprintf "%s\\n" "$*" >>"$CALLS"\n',
    npm: '#!/bin/sh\necho install >>"$CALLS"\nexit "${INSTALL_EXIT:-0}"\n',
  }
  for (const [name, program] of Object.entries(programs)) {
    await writeFile(join(bin, name), program); await chmod(join(bin, name), 0o755)
  }
  const server = createServer((_request, response) => response.end('ok'))
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
  t.after(() => new Promise<void>(accept => server.close(() => accept())))
  const health = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const calls = join(directory, 'calls'), script = join(project, 'scripts/deploy/remote.sh')
  const args = ['sh', script, app, health, 'abc1234', 'api.service', 'worker.service']
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls }
  const deploy = (extra = {}) => exec('sh', ['-c', `${args.map(shellQuote).join(' ')} < ${shellQuote(archive)}`], { env: { ...env, ...extra } })
  const before = await lstat(join(app, '.env'))
  const result = await deploy()
  assert.match(result.stdout, /Deployment complete/)
  assert.equal(await readFile(join(app, '.env'), 'utf8'), 'PRIVATE')
  assert.equal((await lstat(join(app, '.env'))).ino, before.ino)
  assert.equal((await lstat(join(app, '.env'))).mode & 0o777, 0o600)
  assert.ok((await lstat(join(app, 'data'))).isDirectory())
  assert.equal(await readFile(join(app, 'data/record'), 'utf8'), 'persistent')
  assert.equal(await readFile(join(app, 'notes.txt'), 'utf8'), 'unmanaged')
  await assert.rejects(lstat(join(app, 'apps/stale.ts')), { code: 'ENOENT' })
  assert.equal(await readFile(join(app, 'apps/new.ts'), 'utf8'), 'new-code')
  assert.equal(await readFile(join(app, '.deploy-commit'), 'utf8'), 'abc1234\n')
  const log = await readFile(calls, 'utf8')
  assert.match(log, /stop -- api.service worker.service\ninstall\nstart -- api.service worker.service/)
  for (const unit of ['api.service', 'worker.service']) assert.match(log, new RegExp(`is-active --quiet -- ${unit}`))
  await assert.rejects(deploy({ LOCK_BUSY: '1' }), error => (error as { stderr: string }).stderr.includes('Another deployment'))
  assert.equal(await readFile(calls, 'utf8'), log)
  await writeFile(calls, '')
  await assert.rejects(deploy({ INSTALL_EXIT: '1' }))
  assert.ok(!(await readFile(calls, 'utf8')).includes('start --'))
  assert.equal(await readFile(join(app, '.env'), 'utf8'), 'PRIVATE')
  assert.ok(!(await readdir(app, { withFileTypes: true })).some(entry => entry.isDirectory() && entry.name.startsWith('.deploy.')))
  await writeFile(calls, '')
  await rm(join(payload, 'apps'), { recursive: true })
  execFileSync('tar', ['-czf', archive, '-C', payload, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  await assert.rejects(deploy(), error => (error as { stderr: string }).stderr.includes('Incomplete upload'))
  assert.ok(!(await readFile(calls, 'utf8')).includes('stop --'))
  assert.equal(await readFile(join(app, 'apps/new.ts'), 'utf8'), 'new-code')
})
