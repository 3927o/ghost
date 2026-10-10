import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const runtimeFiles = ['apps', 'packages', 'dist', 'package.json', 'package-lock.json']

export function loadConfig(directory: string, env: NodeJS.ProcessEnv) {
  const file = join(directory, '.deploy.env')
  const values = { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...env }
  const required = (key: string) => {
    const value = values[key]?.trim()
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Missing or invalid ${key}.`)
    return value
  }
  const host = required('DEPLOY_HOST')
  if (!/^(?:[\w][\w.-]*@)?[a-zA-Z0-9][\w.-]*$/.test(host)) throw new Error('Invalid DEPLOY_HOST.')
  const path = required('DEPLOY_PATH')
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path.split('/').filter(Boolean).length < 2) {
    throw new Error('DEPLOY_PATH must be an absolute application directory without traversal.')
  }
  const services = required('DEPLOY_SERVICES').split(/ +/)
  if (services.some(name => !/^[a-zA-Z0-9][\w.@:-]*\.service$/.test(name))) throw new Error('Invalid DEPLOY_SERVICES.')
  const healthUrl = required('DEPLOY_HEALTH_URL')
  let health: URL
  try { health = new URL(healthUrl) } catch { throw new Error('Invalid DEPLOY_HEALTH_URL.') }
  if (!['http:', 'https:'].includes(health.protocol) || health.username || health.password) throw new Error('Invalid DEPLOY_HEALTH_URL.')
  return { host, path, services, healthUrl }
}

export function parseRef(args: string[]): string {
  if (!args.length) return 'HEAD'
  if (args.length !== 2 || args[0] !== '--ref' || !args[1] || args[1].startsWith('-') || /[\x00-\x1f\x7f]/.test(args[1])) {
    throw new Error('Usage: npm run deploy -- [--ref COMMIT_OR_TAG_OR_BRANCH]')
  }
  return args[1]
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function validateRef(project: string, commit: string): void {
  const required = ['apps/api/main.ts', 'apps/api/package.json', 'apps/agent-worker/main.ts', 'apps/agent-worker/package.json',
    'packages/config/index.ts', 'packages/database-client/index.ts', 'packages/database-client/drivers/postgres.ts',
    'package.json', 'package-lock.json', 'vite.config.ts']
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', ...required], { cwd: project, encoding: 'utf8' }).split('\n')
  if (required.some(file => !files.includes(file))) throw new Error('Unsupported commit: deployment requires the API/Worker workspaces and ORM database adapters. Older architectures cannot be deployed by this script.')
  const manifest = JSON.parse(execFileSync('git', ['show', `${commit}:package.json`], { cwd: project, encoding: 'utf8' }))
  if (!manifest.workspaces?.includes('apps/*') || !manifest.workspaces?.includes('packages/*') || !manifest.scripts?.['build:web']) {
    throw new Error('Unsupported commit: expected application workspaces and build:web script.')
  }
}

async function run(command: string, args: string[], cwd: string, input?: number): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, {
      cwd, stdio: [input ?? 'ignore', 'inherit', 'inherit'],
      // macOS tar must not include AppleDouble metadata in the Linux upload.
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    child.once('error', () => reject(new Error(`Could not start ${command}.`)))
    child.once('close', code => code === 0 ? accept() : reject(new Error(`${command} failed.`)))
  })
}

export async function validateSource(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || /^\.(?:deploy\.)?env(?:\.|$)/.test(entry.name)
      || ['node_modules', 'data', '.ssh', '.npmrc'].includes(entry.name)
      || /\.(?:pem|key|p12|pfx|sqlite(?:-wal|-shm)?)$/i.test(entry.name)) {
      throw new Error('Deployment inputs contain a private, generated, or linked file.')
    }
    if (entry.isDirectory()) await validateSource(join(directory, entry.name))
  }
}

export async function preparePayload(project: string, work: string, commit: string): Promise<string> {
  validateRef(project, commit)
  const source = join(work, 'source')
  const payload = join(work, 'payload')
  await mkdir(source)
  await run('git', ['archive', `--output=${join(work, 'source.tar')}`, commit, '--',
    'package.json', 'package-lock.json', 'vite.config.ts', 'apps', 'packages'], project)
  await run('tar', ['-xf', join(work, 'source.tar'), '-C', source], project)
  await validateSource(source)
  await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], source)
  await run('npm', ['run', 'build:web'], source)
  if (!(await stat(join(source, 'dist/web/index.html'))).isFile()) throw new Error('Web build output is missing.')
  await mkdir(payload)
  for (const name of runtimeFiles) {
    await cp(join(source, name), join(payload, name), {
      recursive: true, filter: path => !path.split('/').includes('node_modules'),
    })
  }
  await validateSource(payload)
  const archive = join(work, 'application.tar.gz')
  await run('tar', ['--format=ustar', '-czf', archive, '-C', payload, ...runtimeFiles], project)
  return archive
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: npm run deploy -- [--ref COMMIT_OR_TAG_OR_BRANCH]\nDefault: HEAD. Configuration: .deploy.env or environment variables. See docs/deployment.md.')
    return
  }
  const ref = parseRef(args)
  const config = loadConfig(root, process.env)
  const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
  const work = await mkdtemp(join(tmpdir(), 'application-deploy-'))
  try {
    console.log(`[deploy] Building commit ${commit.slice(0, 12)}.`)
    const archive = await preparePayload(root, work, commit)
    const script = readFileSync(join(root, 'scripts/deploy/remote.sh'), 'utf8')
    const command = ['sh', '-c', script, 'deploy', config.path, config.healthUrl, commit, ...config.services].map(shellQuote).join(' ')
    const input = await open(archive, 'r')
    try {
      await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', config.host, command], root, input.fd)
    } finally { await input.close() }
  } finally { await rm(work, { recursive: true, force: true }) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[deploy] ${error.message}`); process.exitCode = 1 })
}
