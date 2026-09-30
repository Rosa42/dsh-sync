/**
 * End-to-end check of the connection self-test against a real WebDAV server.
 *
 * rclone can serve WebDAV itself, so the peer is an rclone process over loopback:
 * no external account, no network access, and no pollution of the user's rclone
 * configuration (RCLONE_CONFIG points at a temporary file). The suite skips when
 * rclone is not on PATH.
 *
 * Run with: node test/probe-round-trip.mjs
 */

import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findRclone } from './rclone.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const RCLONE = await findRclone()
if (RCLONE === null) {
  console.log('skip  rclone was not found; the probe round-trip needs a real remote')
  process.exit(0)
}

function exec(args) {
  return new Promise(resolve => {
    execFile(RCLONE, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        message: error === null ? '' : String(error.message ?? error),
      })
    })
  })
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok    ${label}`)
  } else {
    failures += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-sync-roundtrip-'))
let server = null

try {
  const served = join(sandbox, 'served')
  await mkdir(served, { recursive: true })
  const configFile = join(sandbox, 'rclone.conf')
  await writeFile(configFile, '', 'utf8')

  // Keep the plugin's rclone invocations off the user's real configuration.
  process.env.RCLONE_CONFIG = configFile

  const port = await freePort()
  server = spawn(
    RCLONE,
    ['serve', 'webdav', '--addr', `127.0.0.1:${port}`, served, '--user', 'probe', '--pass', 'probe'],
    { stdio: 'ignore', windowsHide: true },
  )

  const obscured = (await exec(['obscure', 'probe'])).stdout.trim()
  const created = await exec([
    'config', 'create', 'probelab', 'webdav',
    `url=http://127.0.0.1:${port}/`,
    'vendor=rclone',
    'user=probe',
    `pass=${obscured}`,
  ])
  check('a throwaway WebDAV remote can be created', created.ok, created.stderr.trim() || created.message)

  let reachable = false
  for (let attempt = 0; attempt < 60 && !reachable; attempt += 1) {
    await sleep(250)
    reachable = (await exec(['lsd', 'probelab:'])).ok
  }
  check('the WebDAV peer came up', reachable)

  const plugin = await import(pathToFileURL(join(here, '..', 'index.js')).href)
  const routes = []
  plugin.apply({
    effect: factory => factory(),
    connection: { fetch: { register: route => { routes.push(route); return async () => {} } } },
  }, { localRoot: join(sandbox, 'home'), workDir: join(sandbox, 'work') })

  const probeRoute = routes.find(r => r.path === '/api/dsh-sync.probe')
  const response = await probeRoute.fetch(new Request('http://localhost/api/dsh-sync.probe', {
    method: 'POST',
    body: JSON.stringify({ target: 'probelab:probe' }),
  }))
  const result = await response.json()

  check('the probe route answers 200', response.status === 200, String(response.status))
  for (const step of result.steps ?? []) {
    check(`step "${step.id}" passed`, step.ok === true, step.detail)
  }
  check('every step ran', (result.steps ?? []).length === 4, `ran ${(result.steps ?? []).length}`)
  check('the verdict is ok', result.verdict === 'ok', String(result.verdict))
  check('the recommended comparison keeps modtime',
    result.recommendedCompare === 'size,modtime', String(result.recommendedCompare))
  check('a modification-time delta was measured',
    typeof result.steps?.find(step => step.id === 'modtime')?.deltaSeconds === 'number',
    JSON.stringify(result.steps?.find(step => step.id === 'modtime')))

  const leftovers = await exec(['lsf', 'probelab:probe'])
  check('the probe file was removed afterwards',
    leftovers.ok && leftovers.stdout.trim() === '', JSON.stringify(leftovers.stdout.trim()))
} finally {
  if (server !== null) server.kill()
  await rm(sandbox, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
