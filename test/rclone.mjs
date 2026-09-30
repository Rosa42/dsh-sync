/**
 * Locates the rclone executable for the suites that drive it directly.
 *
 * Mirrors the Host half's resolution: PATH first, then winget's command-shim
 * directory. A process started before a winget install inherits a PATH without
 * that directory, so a suite that only checked PATH would skip on a machine
 * where rclone is in fact installed.
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'

const BASE = process.platform === 'win32' ? 'rclone.exe' : 'rclone'

function works(candidate) {
  return new Promise(resolve => {
    execFile(candidate, ['version'], { windowsHide: true }, error => resolve(error === null))
  })
}

/**
 * @returns the usable executable, or null when rclone is not installed.
 */
export async function findRclone() {
  const candidates = [BASE]
  const local = process.env.LOCALAPPDATA
  if (process.platform === 'win32' && typeof local === 'string' && local !== '') {
    candidates.push(join(local, 'Microsoft', 'WinGet', 'Links', BASE))
  }
  for (const candidate of candidates) {
    if (await works(candidate)) return candidate
  }
  return null
}
