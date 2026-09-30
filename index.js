/**
 * Host half of the dsh-sync bundle.
 *
 * Owns four authenticated Fetch routes consumed by this bundle's Client half:
 * a state probe, a settings writer, a remote-creation helper, and a run
 * endpoint that drives `rclone bisync` for the DSH home directory.
 *
 * rclone is executed through `node:child_process` rather than the `subprocess`
 * seam: this is a fixed management binary invoked by an operator-facing page,
 * not agent tool execution, so the agent's sandbox policy must not apply.
 *
 * Configuration lives in `<workDir>/settings.json` and is written by the
 * Client half, because a bundle installed outside a profile cannot resolve the
 * harness's schema package and so cannot declare a validated `Config`. The
 * loader row's `config` seeds only `workDir` and `localRoot`, which must be
 * known before the settings file can be located.
 */

import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-sync'
export const inject = ['connection']

const STATE_PATH = '/api/dsh-sync.state'
const SETTINGS_PATH = '/api/dsh-sync.settings'
const REMOTE_PATH = '/api/dsh-sync.remote'
const RUN_PATH = '/api/dsh-sync.run'
const PROBE_PATH = '/api/dsh-sync.probe'

/** Windows resolves the executable only with its extension under `execFile`. */
const RCLONE = process.platform === 'win32' ? 'rclone.exe' : 'rclone'

const PROBE_TIMEOUT_MS = 20_000
const RUN_TIMEOUT_MS = 15 * 60 * 1000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const SETTINGS_VERSION = 1

/** A probe round-trip talks to a remote twice; give it more room than a local check. */
const PROBE_RUN_TIMEOUT_MS = 120_000

/**
 * The modification time the probe stampes on its file. It is deliberately in the
 * past: a remote that rewrites mtimes to upload time returns "now", which is
 * distinguishable from the sent value by far more than the tolerance.
 */
const PROBE_MTIME = new Date('2020-01-02T03:04:05.000Z')

/** Seconds of drift still treated as a preserved modification time. */
const PROBE_MTIME_TOLERANCE_SECONDS = 3

/**
 * Every selectable slice of the DSH home directory.
 *
 * `excludes` are the rclone filter rules emitted when the slice is disabled;
 * they are never emitted when it is enabled. `secret` marks content holding
 * credentials, and `derived` marks content the harness rebuilds on its own.
 */
const SYNC_ITEMS = [
  { key: 'sessions', excludes: ['/sessions/**'], default: true },
  { key: 'attachments', excludes: ['/attachments/**'], default: true },
  { key: 'profiles', excludes: ['/profiles/**'], default: true },
  { key: 'homeConfig', excludes: ['/cordis.patch.yml', '/AGENTS.md'], default: true },
  { key: 'credentials', excludes: ['/.credentials.yaml', '/.env'], default: false, secret: true },
  { key: 'workspaceState', excludes: ['/storages/**'], default: false, derived: true },
  { key: 'providerCache', excludes: ['/llm-deepseek/**'], default: false, derived: true },
  { key: 'pluginModules', excludes: ['node_modules/**'], default: false, derived: true },
]

/** Excluded regardless of settings: per-install identity, write lock, temp files. */
const ALWAYS_EXCLUDED = ['/.anonymous-user-id', 'session.lock', '*.tmp']

const COMPARE_MODES = ['size,modtime', 'size', 'modtime']
const CONFLICT_MODES = ['none', 'newer', 'older', 'larger', 'smaller', 'path1', 'path2']
const RESYNC_MODES = ['path1', 'path2', 'newer', 'older', 'larger', 'smaller']
const WEBDAV_VENDORS = ['other', 'nextcloud', 'owncloud', 'infinitescale', 'fastmail', 'sharepoint', 'sharepoint-ntlm', 'rclone']

/** A remote target is `<remote>:<subpath>`; the subpath may be empty. */
const TARGET_PATTERN = /^[A-Za-z0-9_.@+-]+:[^\s]*$/
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9_.@+-]+$/

/** Resolved once per activation; see the module doc for why these two differ. */
let localRoot = ''
let workDir = ''

function homeDir() {
  return localRoot
}

function settingsPath() {
  return join(workDir, 'settings.json')
}

function filtersPath() {
  return join(workDir, 'dsh-filters.txt')
}

function logsDir() {
  return join(workDir, 'logs')
}

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Run one command to completion, never rejecting: callers branch on `ok`.
 * @param command - executable name or absolute path.
 * @param args - argv tail, passed without a shell.
 * @param options - `execFile` overrides such as a shorter timeout.
 * @returns the captured result and exit status.
 */
function run(command, args, options = {}) {
  return new Promise(resolve => {
    execFile(
      command,
      args,
      { windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, timeout: RUN_TIMEOUT_MS, ...options },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          message: error === null ? '' : String(error.message ?? error),
        })
      },
    )
  })
}

/** Whether a failed run means the executable is absent rather than erroring. */
function missingExecutable(result) {
  return !result.ok && /ENOENT/.test(result.message)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The settings a fresh installation starts from. */
function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    target: '',
    sync: Object.fromEntries(SYNC_ITEMS.map(item => [item.key, item.default])),
    extraExcludes: [],
    compare: 'size,modtime',
    conflictResolve: 'none',
    maxDelete: 10,
  }
}

/**
 * Coerce arbitrary stored or posted JSON into a complete settings value.
 * @param raw - candidate value from disk or a request body.
 * @returns every field present, with unusable fields replaced by their default.
 */
function normalizeSettings(raw) {
  const base = defaultSettings()
  if (raw === null || typeof raw !== 'object') return base

  const sync = { ...base.sync }
  const postedSync = raw.sync
  if (postedSync !== null && typeof postedSync === 'object') {
    for (const item of SYNC_ITEMS) {
      if (typeof postedSync[item.key] === 'boolean') sync[item.key] = postedSync[item.key]
    }
  }

  return {
    version: SETTINGS_VERSION,
    target: typeof raw.target === 'string' ? raw.target.trim() : base.target,
    sync,
    extraExcludes: Array.isArray(raw.extraExcludes)
      ? raw.extraExcludes
        .filter(value => typeof value === 'string' && value.trim() !== '')
        .map(value => value.trim())
      : base.extraExcludes,
    compare: COMPARE_MODES.includes(raw.compare) ? raw.compare : base.compare,
    conflictResolve: CONFLICT_MODES.includes(raw.conflictResolve) ? raw.conflictResolve : base.conflictResolve,
    maxDelete: Number.isFinite(raw.maxDelete) && raw.maxDelete >= 0 && raw.maxDelete <= 100
      ? raw.maxDelete
      : base.maxDelete,
  }
}

async function readSettings() {
  try {
    return normalizeSettings(JSON.parse(await readFile(settingsPath(), 'utf8')))
  } catch {
    // Absent or unreadable settings mean a fresh install, not an error.
    return defaultSettings()
  }
}

async function writeSettings(settings) {
  await mkdir(workDir, { recursive: true })
  await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/**
 * Render the rclone filter file for a settings value.
 * @param settings - normalized settings.
 * @returns the complete filter file body.
 */
function renderFilters(settings) {
  const lines = [
    '# Generated by the dsh-sync plugin. Do not edit by hand:',
    '# change the sync scope in Settings -> Sync instead, which rewrites this file.',
    '',
  ]
  for (const item of SYNC_ITEMS) {
    if (settings.sync[item.key] === true) continue
    lines.push(`# ${item.key} (disabled)`)
    for (const pattern of item.excludes) lines.push(`- ${pattern}`)
  }
  lines.push('', '# always excluded')
  for (const pattern of ALWAYS_EXCLUDED) lines.push(`- ${pattern}`)
  if (settings.extraExcludes.length > 0) {
    lines.push('', '# extra exclusions')
    for (const pattern of settings.extraExcludes) lines.push(`- ${pattern}`)
  }
  return `${lines.join('\n')}\n`
}

/** Write the filter file when its content would change. */
async function syncFilters(settings) {
  const body = renderFilters(settings)
  try {
    if (await readFile(filtersPath(), 'utf8') === body) return
  } catch {
    // A missing filter file is written below.
  }
  await mkdir(workDir, { recursive: true })
  await writeFile(filtersPath(), body, 'utf8')
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function rcloneState() {
  const probe = await run(RCLONE, ['version'], { timeout: PROBE_TIMEOUT_MS })
  if (missingExecutable(probe)) return { installed: false, version: '', remotes: [] }
  const version = (probe.stdout.split('\n')[0] ?? '').trim()
  const list = await run(RCLONE, ['listremotes'], { timeout: PROBE_TIMEOUT_MS })
  const remotes = list.ok
    ? list.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    : []
  return { installed: probe.ok, version, remotes }
}

async function lastRun() {
  try {
    const names = (await readdir(logsDir())).filter(name => name.endsWith('.log')).sort()
    const name = names.at(-1)
    if (name === undefined) return null
    const full = join(logsDir(), name)
    const info = await stat(full)
    return { name, at: info.mtime.toISOString(), tail: (await readFile(full, 'utf8')).slice(-6000) }
  } catch {
    // No logs directory yet: the page reports "never run" instead of an error.
    return null
  }
}

/** Conflict copies bisync leaves behind, e.g. `cordis.patch.yml.conflict1`. */
async function findConflicts(root, depth = 0) {
  if (depth > 4) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      found.push(...await findConflicts(full, depth + 1))
    } else if (/\.conflict\d+$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

async function readState() {
  const settings = await readSettings()
  await syncFilters(settings)
  const [rclone, last, conflicts] = await Promise.all([
    rcloneState(),
    lastRun(),
    findConflicts(homeDir()),
  ])
  return {
    localRoot: homeDir(),
    workDir,
    filtersPath: filtersPath(),
    settingsPath: settingsPath(),
    settings,
    items: SYNC_ITEMS.map(item => ({
      key: item.key,
      default: item.default,
      secret: item.secret === true,
      derived: item.derived === true,
    })),
    compareModes: COMPARE_MODES,
    conflictModes: CONFLICT_MODES,
    resyncModes: RESYNC_MODES,
    rclone,
    lastRun: last,
    conflicts: conflicts.slice(0, 50),
    conflictCount: conflicts.length,
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function readJsonBody(request) {
  try {
    return { value: JSON.parse(await request.text()) }
  } catch {
    return { error: 'Malformed request body.' }
  }
}

async function handleSettings(request) {
  const body = await readJsonBody(request)
  if (body.error !== undefined) return json({ ok: false, error: body.error }, 400)

  const current = await readSettings()
  const posted = body.value !== null && typeof body.value === 'object' ? body.value : {}
  const next = normalizeSettings({
    ...current,
    ...posted,
    sync: { ...current.sync, ...(posted.sync ?? {}) },
    extraExcludes: posted.extraExcludes ?? current.extraExcludes,
  })

  if (next.target !== '' && !TARGET_PATTERN.test(next.target)) {
    return json({ ok: false, error: 'The target must look like remote:subpath, for example nutstore:dsh.' }, 400)
  }

  await writeSettings(next)
  await syncFilters(next)
  return json({ ok: true, settings: next })
}

/**
 * Create a WebDAV remote non-interactively.
 *
 * `rclone config` is interactive, so this drives `rclone obscure` followed by
 * `rclone config create`. The password reaches rclone as an argv element and is
 * therefore briefly visible to a local process listing; the obscured value is
 * redacted from everything returned to the browser and written to logs.
 */
async function handleRemote(request) {
  const body = await readJsonBody(request)
  if (body.error !== undefined) return json({ ok: false, error: body.error }, 400)

  const source = body.value !== null && typeof body.value === 'object' ? body.value : {}
  const name = typeof source.name === 'string' ? source.name.trim() : ''
  const url = typeof source.url === 'string' ? source.url.trim() : ''
  const user = typeof source.user === 'string' ? source.user.trim() : ''
  const pass = typeof source.pass === 'string' ? source.pass : ''
  const vendor = WEBDAV_VENDORS.includes(source.vendor) ? source.vendor : 'other'

  if (!REMOTE_NAME_PATTERN.test(name)) {
    return json({ ok: false, error: 'The remote name may contain letters, digits, and . _ @ + - only.' }, 400)
  }
  if (!/^https?:\/\/\S+$/.test(url)) {
    return json({ ok: false, error: 'The WebDAV URL must start with http:// or https://.' }, 400)
  }
  if (user === '' || pass === '') {
    return json({ ok: false, error: 'Both the account and the app password are required.' }, 400)
  }

  const probe = await run(RCLONE, ['version'], { timeout: PROBE_TIMEOUT_MS })
  if (missingExecutable(probe)) {
    return json({ ok: false, error: 'rclone is not installed.' }, 400)
  }

  const obscure = await run(RCLONE, ['obscure', pass], { timeout: PROBE_TIMEOUT_MS })
  if (!obscure.ok || obscure.stdout.trim() === '') {
    return json({ ok: false, error: `Could not obscure the password: ${obscure.message}` }, 400)
  }
  const obscured = obscure.stdout.trim()

  const created = await run(RCLONE, [
    'config', 'create', name, 'webdav',
    `url=${url}`,
    `vendor=${vendor}`,
    `user=${user}`,
    `pass=${obscured}`,
  ])
  const raw = [created.stdout, created.stderr].filter(part => part !== '').join('\n').trim()
  // Never echo the obscured secret back to the browser.
  const output = raw.split(obscured).join('<redacted>')

  return json({ ok: created.ok, remote: `${name}:`, output, error: created.ok ? null : output })
}

/**
 * Build the argv for one action.
 * @param action - `preview`, `sync`, or `seed`.
 * @param target - `<remote>:<subpath>` bisync peer.
 * @param settings - normalized settings.
 * @param resyncMode - winner rule, used by `seed` only.
 * @returns rclone argv without the executable.
 */
function buildArgs(action, target, settings, resyncMode) {
  const shared = [
    'bisync', homeDir(), target,
    '--filter-from', filtersPath(),
    '--compare', settings.compare,
    '--max-delete', String(settings.maxDelete),
    '--create-empty-src-dirs',
    '-v',
  ]
  if (action === 'seed') {
    return [...shared, '--resync', '--resync-mode', resyncMode]
  }
  const routine = [
    ...shared,
    '--conflict-resolve', settings.conflictResolve,
    '--resilient',
    '--recover',
    '--max-lock', '2m',
  ]
  return action === 'preview' ? [...routine, '--dry-run'] : routine
}

async function writeRunLog(action, target, output) {
  try {
    await mkdir(logsDir(), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await appendFile(join(logsDir(), `ui-${stamp.slice(0, 10)}.log`), `# ${stamp} action=${action} target=${target}\n${output}\n`)
  } catch {
    // Log persistence is best-effort; the page still receives the output.
  }
}

async function handleRun(request) {
  const body = await readJsonBody(request)
  if (body.error !== undefined) return json({ ok: false, error: body.error }, 400)

  const source = body.value !== null && typeof body.value === 'object' ? body.value : {}
  const action = source.action
  const settings = await readSettings()
  const target = (typeof source.target === 'string' && source.target.trim() !== '' ? source.target : settings.target).trim()
  const resyncMode = RESYNC_MODES.includes(source.resyncMode) ? source.resyncMode : 'path1'

  if (action !== 'preview' && action !== 'sync' && action !== 'seed') {
    return json({ ok: false, error: `Unsupported action: ${String(action)}` }, 400)
  }
  if (!TARGET_PATTERN.test(target)) {
    return json({ ok: false, error: 'Choose a remote and a subpath first, for example nutstore:dsh.' }, 400)
  }

  const remoteName = `${target.slice(0, target.indexOf(':'))}:`
  const { remotes } = await rcloneState()
  if (!remotes.includes(remoteName)) {
    return json({ ok: false, error: `rclone has no configured remote named ${remoteName}` }, 400)
  }

  await syncFilters(settings)
  const result = await run(RCLONE, buildArgs(action, target, settings, resyncMode))
  const output = [result.stdout, result.stderr].filter(part => part !== '').join('\n').trim()
  await writeRunLog(action, target, output)

  return json({
    ok: result.ok,
    exitCode: result.code,
    output: output === '' ? result.message : output,
    action,
    target,
  })
}

/**
 * Verify a remote is reachable, writable, and preserves modification times.
 *
 * bisync compares `size,modtime` between runs, so a remote that rewrites an
 * uploaded file's modification time makes every run look like a change on both
 * sides: the sync appears to work while repeatedly copying the same files. That
 * failure is silent, so it is measured here before anything is seeded.
 *
 * The probe goes through the configured rclone remote rather than speaking
 * WebDAV itself, which keeps the credential inside rclone's config. One
 * temporary file is uploaded, read back, and removed; the report states what the
 * remote actually did, plus the comparison mode that follows from it.
 *
 * @param target - `<remote>:<subpath>` peer to test.
 * @returns the per-step results, a verdict, the recommended comparison mode, and
 * the hash types the remote reports.
 */
async function probeRemote(target) {
  const steps = []
  const remoteRoot = `${target.slice(0, target.indexOf(':'))}:`

  const reach = await run(RCLONE, ['lsd', remoteRoot], { timeout: PROBE_RUN_TIMEOUT_MS })
  steps.push({
    id: 'reach',
    ok: reach.ok,
    detail: reach.ok
      ? 'The remote answered an authenticated listing.'
      : (reach.stderr.trim() || reach.message),
  })
  if (!reach.ok) return { steps, verdict: 'unreachable', recommendedCompare: null, hashes: [] }

  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-sync-probe-'))
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const probeName = `.dsh-sync-probe-${stamp}.txt`
  const remoteFile = `${target.replace(/\/+$/, '')}/${probeName}`
  const localFile = join(sandbox, probeName)
  const body = `dsh-sync probe ${stamp}\n`

  try {
    await writeFile(localFile, body, 'utf8')
    await utimes(localFile, PROBE_MTIME, PROBE_MTIME)

    const put = await run(RCLONE, ['copyto', localFile, remoteFile], { timeout: PROBE_RUN_TIMEOUT_MS })
    steps.push({
      id: 'write',
      ok: put.ok,
      detail: put.ok
        ? 'A probe file was uploaded.'
        : (put.stderr.trim() || put.message),
    })
    if (!put.ok) return { steps, verdict: 'read-only', recommendedCompare: null, hashes: [] }

    const info = await run(RCLONE, ['lsjson', remoteFile, '--stat'], { timeout: PROBE_RUN_TIMEOUT_MS })
    if (!info.ok) {
      steps.push({ id: 'readback', ok: false, detail: info.stderr.trim() || info.message })
      return { steps, verdict: 'partial', recommendedCompare: null, hashes: [] }
    }

    let meta = null
    try {
      meta = JSON.parse(info.stdout)
    } catch {
      // A non-JSON listing is reported through the readback step below.
      meta = null
    }

    const expectedBytes = Buffer.byteLength(body)
    const sizeOk = meta !== null && meta.Size === expectedBytes
    steps.push({
      id: 'readback',
      ok: sizeOk,
      detail: sizeOk
        ? 'The uploaded file read back at the expected size.'
        : `Expected ${expectedBytes} bytes; the remote reported ${meta?.Size ?? 'nothing'}.`,
    })

    const actualMtime = meta !== null && typeof meta.ModTime === 'string' ? new Date(meta.ModTime) : null
    const valid = actualMtime !== null && !Number.isNaN(actualMtime.getTime())
    const deltaSeconds = valid ? Math.round((actualMtime.getTime() - PROBE_MTIME.getTime()) / 1000) : null
    const modtimeOk = deltaSeconds !== null && Math.abs(deltaSeconds) <= PROBE_MTIME_TOLERANCE_SECONDS
    steps.push({
      id: 'modtime',
      ok: modtimeOk,
      expected: PROBE_MTIME.toISOString(),
      actual: valid ? actualMtime.toISOString() : null,
      deltaSeconds,
      detail: modtimeOk
        ? `The remote kept the modification time (off by ${deltaSeconds}s).`
        : valid
          ? `Sent ${PROBE_MTIME.toISOString()}; the remote reports ${actualMtime.toISOString()} — off by ${deltaSeconds}s.`
          : 'The remote reported no modification time.',
    })

    const hashes = meta !== null && meta.Hashes !== null && typeof meta.Hashes === 'object'
      ? Object.keys(meta.Hashes)
      : []

    return {
      steps,
      verdict: modtimeOk ? 'ok' : 'modtime-mismatch',
      recommendedCompare: modtimeOk ? 'size,modtime' : 'size',
      hashes,
    }
  } finally {
    // Never leave the probe file behind: the next bisync would otherwise copy it.
    await run(RCLONE, ['deletefile', remoteFile], { timeout: PROBE_RUN_TIMEOUT_MS })
    await rm(sandbox, { recursive: true, force: true })
  }
}

async function handleProbe(request) {
  const body = await readJsonBody(request)
  if (body.error !== undefined) return json({ ok: false, error: body.error }, 400)

  const source = body.value !== null && typeof body.value === 'object' ? body.value : {}
  const settings = await readSettings()
  const target = (typeof source.target === 'string' && source.target.trim() !== ''
    ? source.target
    : settings.target).trim()

  if (!TARGET_PATTERN.test(target)) {
    return json({ ok: false, error: 'Choose a remote and a subpath first, for example nutstore:dsh.' }, 400)
  }

  const remoteName = `${target.slice(0, target.indexOf(':'))}:`
  const { installed, remotes } = await rcloneState()
  if (!installed) return json({ ok: false, error: 'rclone is not installed.' }, 400)
  if (!remotes.includes(remoteName)) {
    return json({ ok: false, error: `rclone has no configured remote named ${remoteName}` }, 400)
  }

  return json({ ok: true, target, ...await probeRemote(target) })
}

/**
 * Register the state, settings, remote, probe, and run routes.
 * @param ctx - Host context carrying the Connection service.
 * @param config - the loader row's raw config; only path seeds are read.
 */
export function apply(ctx, config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  localRoot = typeof source.localRoot === 'string' && source.localRoot.trim() !== ''
    ? source.localRoot.trim()
    : (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  workDir = typeof source.workDir === 'string' && source.workDir.trim() !== ''
    ? source.workDir.trim()
    : join(homedir(), '.dsh-sync')

  const connection = connectionOf(ctx)
  const routes = [
    [STATE_PATH, ['GET'], async () => json(await readState())],
    [SETTINGS_PATH, ['POST'], handleSettings],
    [REMOTE_PATH, ['POST'], handleRemote],
    [PROBE_PATH, ['POST'], handleProbe],
    [RUN_PATH, ['POST'], handleRun],
  ]
  for (const [path, methods, fetch] of routes) {
    ctx.effect(
      () => connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }),
      `dsh-sync: ${path}`,
    )
  }
}
