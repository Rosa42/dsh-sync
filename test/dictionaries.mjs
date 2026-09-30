/**
 * Checks the Client half's dictionaries without a browser: both languages must
 * define the same keys, every t('...') call must resolve, and the indirectly
 * referenced ITEM_TEXT keys must exist. Run with: node test/dictionaries.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const text = await readFile(join(here, '..', 'client.js'), 'utf8')

function keysOf(name) {
  const start = text.indexOf(`const ${name} = {`)
  if (start === -1) throw new Error(`missing the ${name} dictionary`)
  const end = text.indexOf('\n    };', start)
  if (end === -1) throw new Error(`unterminated the ${name} dictionary`)
  const keys = new Set()
  for (const line of text.slice(start, end).split('\n')) {
    const match = /^\s*'([^']+)':/.exec(line)
    if (match !== null) keys.add(match[1])
  }
  return keys
}

const zh = keysOf('zh')
const en = keysOf('en')

const onlyZh = [...zh].filter(key => !en.has(key))
const onlyEn = [...en].filter(key => !zh.has(key))

const used = new Set()
for (const match of text.matchAll(/\bt\('([^']+)'\)/g)) used.add(match[1])
const missing = [...used].filter(key => !zh.has(key))

// ITEM_TEXT resolves labels through t(text[0]) / t(text[1]), which the regex
// above cannot follow, so those pairs are checked explicitly.
const indirect = new Set()
for (const match of text.matchAll(/\['(item\.[^']+)', '(item\.[^']+)'\]/g)) {
  indirect.add(match[1])
  indirect.add(match[2])
}
const indirectMissing = [...indirect].filter(key => !zh.has(key))

// The self-test builds its labels as t('probe.step.' + id) and
// t('probe.verdict.' + verdict), so a static scan cannot follow them. Those keys
// are instead validated against the values the Host half actually emits, which
// is the mistake that matters: an unlabelled verdict would render as a raw key.
const hostSource = await readFile(join(here, '..', 'index.js'), 'utf8')
const stepIds = [...hostSource.matchAll(/\bid: '([a-z][a-z-]*)',\n\s+ok:/g)].map(m => m[1])
// A verdict is often a ternary (`modtimeOk ? 'ok' : 'modtime-mismatch'`), so every
// quoted literal on a `verdict:` line counts, not just a bare assignment.
const verdicts = [...hostSource.matchAll(/\bverdict:[^\n]*/g)]
  .flatMap(line => [...line[0].matchAll(/'([a-z][a-z-]*)'/g)].map(m => m[1]))
const dynamic = new Set([
  ...stepIds.map(id => `probe.step.${id}`),
  ...verdicts.map(verdict => `probe.verdict.${verdict}`),
])

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok    ${label}`)
  } else {
    failures += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

console.log(`zh keys: ${zh.size}   en keys: ${en.size}   direct t() calls: ${used.size}`)
check('no key is defined only in zh', onlyZh.length === 0, onlyZh.join(', '))
check('no key is defined only in en', onlyEn.length === 0, onlyEn.join(', '))
check('every directly referenced key exists', missing.length === 0, missing.join(', '))
check(`every one of the ${indirect.size} indirectly referenced keys exists`,
  indirectMissing.length === 0, indirectMissing.join(', '))

check(`the Host emits at least one step id (${stepIds.join(', ') || 'none'})`, stepIds.length > 0)
check(`the Host emits at least one verdict (${verdicts.join(', ') || 'none'})`, verdicts.length > 0)
const unlabelled = [...dynamic].filter(key => !zh.has(key))
check('every step id and verdict the Host emits has a label',
  unlabelled.length === 0, unlabelled.join(', '))

const reachable = new Set([...used, ...indirect, 'nav', ...dynamic])
const unreachable = [...zh].filter(key => !reachable.has(key))
check('no key is unreachable', unreachable.length === 0, unreachable.join(', '))

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
