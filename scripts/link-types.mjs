// Recreate the node_modules/@deepseek-ai junctions that point type resolution
// at the local deepseek-harness checkout. Run this after every `npm install`
// (npm prunes directories it does not have in its lockfile).
// Why: the npm registry only has rc-era @deepseek-ai packages; typecheck must
// see the current alpha types. cordis is junctioned to the harness VENDOR copy
// on purpose: declare-module augmentations (Context services, Events) from the
// harness packages and from this plugin must land on ONE cordis identity.
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const harness = process.env.DSH_CHECKOUT ?? 'D:/deepseek-harness'
const scoped = join(pluginRoot, 'node_modules', '@deepseek-ai')

const links = {
  cordis: join(harness, 'vendor', 'cordis'),
  'dsh-agent': join(harness, 'packages', 'core', 'agent'),
  'dsh-api-session-controller': join(harness, 'packages', 'api', 'session-controller'),
  'dsh-client-connection': join(harness, 'packages', 'client', 'connection'),
  'dsh-client-store': join(harness, 'packages', 'client', 'store'),
  'dsh-client-ui-conversation': join(harness, 'packages', 'client', 'ui-conversation'),
  'dsh-client-ui-slots': join(harness, 'packages', 'client', 'ui-slots'),
  'dsh-client-ui-renderer': join(harness, 'packages', 'client', 'ui-renderer'),
  'dsh-llm': join(harness, 'packages', 'llm', 'llm'),
  'dsh-session': join(harness, 'packages', 'core', 'session'),
  'dsh-session-query': join(harness, 'packages', 'session-query', 'session-query'),
  'dsh-workspace': join(harness, 'packages', 'workspace', 'workspace'),
}

if (!existsSync(join(harness, 'package.json'))) {
  console.error('link-types: harness checkout not found at ' + harness)
  process.exit(1)
}

let created = 0
for (const [name, target] of Object.entries(links)) {
  const link = join(scoped, name)
  rmSync(link, { recursive: true, force: true })
  const result = spawnSync('cmd', ['/d', '/s', '/c', 'mklink', '/J', link, resolve(target)], { stdio: 'pipe' })
  if (result.status !== 0) {
    console.error('link-types: junction failed for ' + name)
    process.exit(1)
  }
  if (!existsSync(join(link, 'package.json'))) {
    console.error('link-types: junction for ' + name + ' does not expose package.json')
    process.exit(1)
  }
  created += 1
}
console.log('link-types: ' + created + ' junctions created (cordis unified to the harness vendor copy)')