# dsh-sync

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that adds a **Settings → Sync** page for carrying one machine's DSH home directory (`~/.dsh`) to other machines: session logs and profile configuration, synced bidirectionally through any rclone remote.

It wraps [rclone bisync](https://rclone.org/bisync/) so that none of the following has to be done by hand: editing rclone filter files, remembering the `--resync` seeding order, or running `rclone config` interactively.

## What the page does

| Area | Purpose |
|---|---|
| Current state | Whether rclone is installed, the resolved local and working directories, the generated rules file, the last run, and how many conflict copies exist |
| Sync target | Cloud remote picked from `rclone listremotes`, plus a subpath, composed into `remote:subpath` |
| Connection self-test | Reachability, writability, and modification-time fidelity of the target, before anything is seeded |
| Sync scope | Per-slice toggles for what travels between machines, extra exclusion rules, comparison mode, conflict handling, deletion ceiling |
| Configure cloud storage | Creates a WebDAV remote non-interactively, with a Nutstore (坚果云) preset |
| Actions | Preview changes (`--dry-run`), sync now, first-time seed (`--resync`) |
| Run output | The full rclone output, also appended to `logs/ui-<date>.log` |
| Conflict copies | Every `*.conflictN` file left behind, so it can be merged by hand |

## The connection self-test

Run this before the first seed, and after changing remotes. It uploads one temporary file through the configured remote, reads its metadata back, and removes it — so the credential never leaves rclone's own configuration.

| Step | What it proves | What a failure means |
|---|---|---|
| Reachability | The remote answers an authenticated listing | Wrong URL, wrong account, no network, or a bridge process that is not running |
| Writability | A file can be uploaded | The account is read-only, or the server gates writes behind a permission it lacks |
| Content check | The upload read back at the expected size | The transfer path corrupts data |
| Modification time | The remote returned the time the file was sent with | **A two-way sync will misread every run** |

The last step is the one that cannot be inferred from any documentation. `bisync` compares `size,modtime` against the previous run's listing, so a remote that replaces the modification time with the upload time makes both sides look changed on every pass: files are retransferred, and conflict copies accumulate. The probe dates its file to a fixed past instant, which is far enough from "now" to be unambiguous.

When the remote rewrites modification times the verdict says so, recommends `size`, and offers to apply it. Take that recommendation deliberately rather than silently: `size` alone cannot detect an edit that leaves the file the same length.

```sh
npm test   # includes both probe suites; they skip when rclone is not on PATH
```

## Install

The plugin is an ordinary DSH bundle. Author or unpack it anywhere on disk, then install it into a profile:

```
plugin_manager install_bundle  target: <absolute path to this directory>
```

Installing links the directory into the profile and enables the bundle. **Restart the `dsh web` server afterwards**: the Cordis loader caches the module path it resolved for an entry, so a replaced or relocated plugin keeps running the previous JavaScript module generation until the process restarts. Changing a directory or a row id does not bypass that cache.

## Configuration

Settings live in `<workDir>/settings.json` and are written by the page. They are a plain JSON document:

```json
{
  "version": 1,
  "target": "nutstore:dsh",
  "sync": {
    "sessions": true,
    "attachments": true,
    "profiles": true,
    "homeConfig": true,
    "credentials": false,
    "workspaceState": false,
    "providerCache": false,
    "pluginModules": false
  },
  "extraExcludes": [],
  "compare": "size,modtime",
  "conflictResolve": "none",
  "maxDelete": 10
}
```

The loader row's `config` seeds the two paths that must be known before the settings file can be found:

```yaml
- id: dsh-sync
  name: '@local/dsh-sync'
  config:
    localRoot: /home/me/.dsh   # default: $DSH_HOME, then ~/.dsh
    workDir: /home/me/.dsh-sync # default: ~/.dsh-sync
```

### Why settings are not a `Config` schema

A bundle installed outside a profile cannot resolve `@deepseek-ai/schemastery`, so it cannot export the validated `Config` schema the harness expects. The settings file replaces it and the page is the editing surface. A deployment that installs this bundle from inside a profile can switch to a schema-backed `Config` without changing the route contract.

### Sync scope

Each slice maps to rclone filter rules emitted when the slice is **disabled**:

| Key | Content | Default |
|---|---|---|
| `sessions` | `sessions/**` — one append-only log per session | on |
| `attachments` | `attachments/**` — images and files a session references | on |
| `profiles` | `profiles/**` — bundles, patch layers, lockfiles | on |
| `homeConfig` | `cordis.patch.yml`, `AGENTS.md` at the home root | on |
| `credentials` | `.credentials.yaml`, `.env` — plaintext API keys | off |
| `workspaceState` | `storages/**` — sidebar grouping and derived caches | off |
| `providerCache` | `llm-deepseek/**` — expiring vendor upload records | off |
| `pluginModules` | `node_modules/**` — platform-specific binaries and absolute links | off |

`/.anonymous-user-id`, `session.lock`, and `*.tmp` are always excluded.

The rules file is **generated**; editing it by hand has no effect, because the next state read rewrites it from the settings. Changing settings also invalidates bisync's remembered filter hash, which is why the page regenerates it before every run.

## Nutstore (坚果云) and other WebDAV servers

The page creates the remote through `rclone obscure` followed by `rclone config create`, so the interactive `rclone config` flow is never needed.

For Nutstore: URL `https://dav.jianguoyun.com/dav/`, vendor `other`, and an **app password** generated under Account information → Security options → Add app password. The login password does not work over WebDAV.

Two properties of plain WebDAV matter for bisync:

- **Modification times.** rclone reports modified times only for Fastmail Files, ownCloud, and Nextcloud. On a plain WebDAV server the remote copy's modification time is the upload time, which can make bisync see spurious changes. Start with the default `size,modtime`; if a preview lists a large number of changes on an otherwise idle tree, switch **Change comparison** to `size`.
- **Hashes.** Plain WebDAV reports none, so checksum comparison would require downloading every file. It is deliberately not offered as a comparison mode.

The password is passed to `rclone obscure` as a process argument, so it is briefly visible to a local process listing. It is never written to the settings file or the logs, and the obscured value is redacted from everything returned to the browser.

## Seeding order

`--resync` makes both sides a superset: a file present on only one side always survives. Only a file present on both sides with different content needs a winner, chosen by the resync mode.

1. On the machine holding the most complete state, run **First-time seed** with winner `path1` (local wins). The remote is empty, so nothing can be lost.
2. On every other machine, run **First-time seed** with winner `path2` (remote wins). That machine's unique sessions are uploaded, and its same-named configuration files are replaced by the cloud copy — which is what "keep the machines consistent" means.
3. Afterwards use **Sync now**. `--resync` is only for a first pairing, a changed rules file, or recovery from a failed run; using it routinely resurrects deleted files.

Preview every seed with **Preview changes** first.

## Operating constraints

- **Do not continue the same session on two machines.** Session logs are append-only; two writers diverge and the sync can only leave a conflict copy.
- **Keep project paths identical across machines.** A session header records the absolute `cwd` it was created in, and the sidebar groups sessions by it. A session copied to a machine without that path is grouped under a workspace path that does not exist there.
- **Host-side edits need a server restart** — see Install.

## Routes

All five are exact Fetch routes under `/api/`, so Connection applies its Host/Origin checks and browser authentication. The browser addresses them document-relative, without the leading slash.

| Route | Method | Body | Returns |
|---|---|---|---|
| `/api/dsh-sync.state` | GET | — | Settings, sync-scope catalogue, rclone state, last run, conflicts |
| `/api/dsh-sync.settings` | POST | Partial settings | `{ ok, settings }` |
| `/api/dsh-sync.remote` | POST | `{ name, url, user, pass, vendor }` | `{ ok, remote, output }` |
| `/api/dsh-sync.probe` | POST | `{ target }` | `{ ok, target, steps, verdict, recommendedCompare, hashes }` |
| `/api/dsh-sync.run` | POST | `{ action, target, resyncMode }` | `{ ok, exitCode, output }` |

`action` is `preview`, `sync`, or `seed`. A probe `verdict` is one of `ok`, `modtime-mismatch`, `unreachable`, `read-only`, or `partial`.

## Development

There is no build step: the Host half is plain ESM and the Client half is a plain-JavaScript module-loader factory.

```sh
node --check index.js && node --check client.js   # syntax
npm test                                          # all four suites
```

| Suite | Covers | Needs |
|---|---|---|
| `test/host-routes.mjs` | Builds a stub `Context` whose `connection.fetch.register` records routes, calls `apply(ctx, { localRoot, workDir })` with both paths redirected into a temporary directory, then invokes every route with a real `Request`. It never touches a real DSH home. | nothing |
| `test/dictionaries.mjs` | Both dictionaries define the same keys, every `t('...')` call resolves, the indirectly referenced `ITEM_TEXT` labels exist, and every step id and verdict the Host can emit has a label. | nothing |
| `test/probe-round-trip.mjs` | Runs the self-test against an rclone-served WebDAV peer over loopback and asserts a healthy verdict. Sets `RCLONE_CONFIG` to a temporary file, so the user's own remotes are untouched. | rclone on PATH |
| `test/probe-modtime-mismatch.mjs` | Runs the self-test against a minimal WebDAV server that deliberately reports the wrong modification time, and asserts the probe catches it and recommends `size`. | rclone on PATH |

The two probe suites skip with a printed reason when rclone is absent, so `npm test` stays green on a machine that has not installed it yet.

## License

MIT — see [LICENSE](LICENSE).
