/**
 * Drives the Host half's four Fetch routes through a stub Context, with the
 * local root and working directory redirected into a temporary directory so the
 * run never touches a real DSH home. Run with: node test/host-routes.mjs
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(join(here, '..', 'index.js')).href)

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-sync-test-'))
const localRoot = join(sandbox, 'dsh-home')
const workDir = join(sandbox, 'work')

const routes = []
const ctx = {
  effect: factory => factory(),
  connection: { fetch: { register: route => { routes.push(route); return async () => {} } } },
}
plugin.apply(ctx, { localRoot, workDir })

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok    ${label}`)
  } else {
    failures += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

async function call(path, body) {
  const route = routes.find(candidate => candidate.path === path)
  const request = body === undefined
    ? new Request(`http://localhost${path}`)
    : new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })
  const response = await route.fetch(request)
  return { status: response.status, value: await response.json() }
}

try {
  check('registers five routes', routes.length === 5, routes.map(r => r.path).join(', '))
  check('every route is an /api exact route',
    routes.every(r => r.path.startsWith('/api/')), routes.map(r => r.path).join(', '))

  const state = await call('/api/dsh-sync.state')
  check('state answers 200', state.status === 200, String(state.status))
  check('state reports the seeded local root', state.value.localRoot === localRoot, state.value.localRoot)
  check('state reports the seeded working directory', state.value.workDir === workDir, state.value.workDir)
  check('state ships the eight sync items', state.value.items.length === 8, String(state.value.items.length))
  check('secrets are off by default', state.value.settings.sync.credentials === false)
  check('generated rules exclude the credential files',
    (await readFile(state.value.filtersPath, 'utf8')).includes('- /.credentials.yaml'))

  const badTarget = await call('/api/dsh-sync.settings', { target: 'no colon here' })
  check('settings rejects a malformed target', badTarget.status === 400, String(badTarget.status))

  const saved = await call('/api/dsh-sync.settings', {
    target: 'nutstore:dsh',
    sync: { credentials: true, pluginModules: true },
    extraExcludes: ['/profiles/sdk/**', '   '],
    compare: 'size',
    maxDelete: 25,
  })
  check('settings persists a valid change', saved.status === 200, String(saved.status))
  check('blank extra rules are dropped',
    JSON.stringify(saved.value.settings.extraExcludes) === '["/profiles/sdk/**"]',
    JSON.stringify(saved.value.settings.extraExcludes))
  check('an enabled slice disappears from the rules',
    !(await readFile(state.value.filtersPath, 'utf8')).includes('- /.credentials.yaml'))
  check('an extra rule reaches the rules file',
    (await readFile(state.value.filtersPath, 'utf8')).includes('- /profiles/sdk/**'))

  const rejected = await call('/api/dsh-sync.settings', { compare: 'nonsense', maxDelete: 999 })
  check('unusable fields fall back to defaults',
    rejected.value.settings.compare === 'size,modtime' && rejected.value.settings.maxDelete === 10,
    `${rejected.value.settings.compare} / ${rejected.value.settings.maxDelete}`)

  const remoteGuards = [
    [{ name: 'bad name', url: 'https://x', user: 'u', pass: 'p' }, 'remote name'],
    [{ name: 'ok', url: 'ftp://x', user: 'u', pass: 'p' }, 'WebDAV URL'],
    [{ name: 'ok', url: 'https://x', user: '', pass: 'p' }, 'account and password'],
  ]
  for (const [body, label] of remoteGuards) {
    const result = await call('/api/dsh-sync.remote', body)
    check(`remote route refuses a bad ${label}`, result.status === 400, String(result.status))
  }

  const probeGuards = [
    [{ target: 'bad target with spaces' }, 'target'],
    [{ target: 'nosuchremote:dsh' }, 'unconfigured remote'],
  ]
  for (const [body, label] of probeGuards) {
    const result = await call('/api/dsh-sync.probe', body)
    check(`probe route refuses a bad ${label}`, result.status === 400, String(result.status))
  }

  const probeMalformed = await call('/api/dsh-sync.probe', undefined)
  check('probe route rejects a malformed body', probeMalformed.status === 400, String(probeMalformed.status))

  // The probe's round-trip needs a real rclone and a reachable remote, so it is
  // covered by test/probe-round-trip.mjs rather than here.
  if (state.value.rclone.installed !== true) {
    console.log('note  probe round-trip is not covered here (rclone is absent); run test/probe-round-trip.mjs')
  }

  const runGuards = [
    [{ action: 'nope', target: 'nutstore:dsh' }, 'action'],
    [{ action: 'sync', target: 'bad target with spaces' }, 'target'],
    [{ action: 'sync', target: 'nosuchremote:dsh' }, 'unconfigured remote'],
  ]
  for (const [body, label] of runGuards) {
    const result = await call('/api/dsh-sync.run', body)
    check(`run route refuses a bad ${label}`, result.status === 400, String(result.status))
  }

  const malformed = await call('/api/dsh-sync.run', undefined)
  check('run route rejects a malformed body', malformed.status === 400, String(malformed.status))
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
