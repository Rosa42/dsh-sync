/**
 * Verifies the self-test actually reports a modification-time mismatch.
 *
 * A minimal WebDAV server answers rclone's PROPFIND, PUT, MKCOL and DELETE, and
 * deliberately reports a modification time of "now" instead of the one it was
 * sent — the behaviour that makes an unattended bisync thrash. The suite asserts
 * the probe catches it and recommends dropping modtime from the comparison.
 *
 * Run with: node test/probe-modtime-mismatch.mjs
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RCLONE = process.platform === 'win32' ? 'rclone.exe' : 'rclone'

function exec(args) {
  return new Promise(resolve => {
    execFile(RCLONE, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), message: error === null ? '' : String(error.message ?? error) })
    })
  })
}

const version = await exec(['version'])
if (!version.ok && /ENOENT/.test(version.message)) {
  console.log('skip  rclone is not on PATH; this suite drives rclone against a fake server')
  process.exit(0)
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

/** The lie: every entry reports this modification time, whatever was uploaded. */
const REPORTED_MTIME = new Date().toUTCString()
const files = new Map()

function multistatus(href, isCollection, size) {
  const type = isCollection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>'
  const length = isCollection ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`
  return '<D:response>'
    + `<D:href>${href}</D:href>`
    + '<D:propstat><D:prop>'
    + `<D:getlastmodified>${REPORTED_MTIME}</D:getlastmodified>`
    + length
    + type
    + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>'
    + '</D:response>'
}

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const path = decodeURIComponent(url.pathname)
  const depth = request.headers.depth ?? '0'
  if (process.env.DSH_SYNC_TEST_TRACE === '1') console.log(`  req  ${request.method} ${path} depth=${depth}`)

  if (request.method === 'PROPFIND') {
    const send = body => {
      response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`)
    }
    if (path === '/') {
      const children = depth === '1'
        ? [...files].map(([name, size]) => multistatus(name, false, size)).join('')
        : ''
      send(multistatus('/', true, 0) + children)
      return
    }
    // An unknown path must be 404, not an empty collection: rclone asks about the
    // destination before uploading and treats a collection as "is a directory".
    if (files.has(path)) {
      send(multistatus(path, false, files.get(path)))
      return
    }
    response.writeHead(404).end()
    return
  }
  if (request.method === 'PUT') {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      files.set(path, Buffer.concat(chunks).length)
      response.writeHead(201).end()
    })
    return
  }
  if (request.method === 'MKCOL') {
    response.writeHead(201).end()
    return
  }
  if (request.method === 'DELETE') {
    files.delete(path)
    response.writeHead(204).end()
    return
  }
  if (request.method === 'HEAD' || request.method === 'GET') {
    response.writeHead(200, { 'content-length': String(files.get(path) ?? 0) }).end()
    return
  }
  response.writeHead(405).end()
})

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-sync-mismatch-'))

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  process.env.RCLONE_CONFIG = join(sandbox, 'rclone.conf')
  await writeFile(process.env.RCLONE_CONFIG, '', 'utf8')

  const obscured = (await exec(['obscure', 'probe'])).stdout.trim()
  const created = await exec([
    'config', 'create', 'liar', 'webdav',
    `url=http://127.0.0.1:${port}/`,
    'vendor=other',
    'user=probe',
    `pass=${obscured}`,
  ])
  check('a remote against the fake server can be created', created.ok, created.stderr.trim() || created.message)

  const plugin = await import(pathToFileURL(join(here, '..', 'index.js')).href)
  const routes = []
  plugin.apply({
    effect: factory => factory(),
    connection: { fetch: { register: route => { routes.push(route); return async () => {} } } },
  }, { localRoot: join(sandbox, 'home'), workDir: join(sandbox, 'work') })

  const response = await routes.find(r => r.path === '/api/dsh-sync.probe').fetch(
    new Request('http://localhost/api/dsh-sync.probe', {
      method: 'POST',
      body: JSON.stringify({ target: 'liar:probe' }),
    }),
  )
  const result = await response.json()
  const modtime = (result.steps ?? []).find(step => step.id === 'modtime')

  check('the probe route answers 200', response.status === 200, String(response.status))
  check('reachability passed', result.steps?.find(s => s.id === 'reach')?.ok === true,
    result.steps?.find(s => s.id === 'reach')?.detail)
  check('writability passed', result.steps?.find(s => s.id === 'write')?.ok === true,
    result.steps?.find(s => s.id === 'write')?.detail)
  check('the modification-time step failed', modtime?.ok === false, JSON.stringify(modtime))
  check('the mismatch is quantified', Math.abs(modtime?.deltaSeconds ?? 0) > 60, `delta ${modtime?.deltaSeconds}s`)
  check('the verdict reports a mismatch', result.verdict === 'modtime-mismatch', String(result.verdict))
  check('the probe recommends size only', result.recommendedCompare === 'size', String(result.recommendedCompare))
  check('the probe file was removed from the fake server', files.size === 0, JSON.stringify([...files.keys()]))
} finally {
  server.close()
  await rm(sandbox, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
