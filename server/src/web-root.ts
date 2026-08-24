import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundledWebRoot = fileURLToPath(new URL('../../web/', import.meta.url))

export function webRoot(cwd = process.cwd()): string {
  const cwdRoot = join(cwd, 'web')
  return existsSync(cwdRoot) ? cwdRoot : bundledWebRoot
}

export function webFile(name: string, cwd = process.cwd()): string {
  return join(webRoot(cwd), name)
}
