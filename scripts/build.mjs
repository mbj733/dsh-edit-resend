import { copyFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: pluginRoot,
      stdio: 'inherit',
      env: process.env,
      // .cmd shims on Windows require a shell; POSIX shims are direct executables.
      shell: process.platform === 'win32',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(command + ' exited with ' + (code ?? 'signal ' + signal)))
    })
  })
}

const binExt = process.platform === 'win32' ? '.cmd' : ''

const dist = join(pluginRoot, 'dist')
await rm(dist, { recursive: true, force: true })
await run(join(pluginRoot, 'node_modules/.bin/tsc') + binExt, ['-p', 'tsconfig.json'])
await run(join(pluginRoot, 'node_modules/.bin/tsdown') + binExt, ['--config-loader', 'tsx', '--config', 'tsdown.config.ts'])
await copyFile(join(dist, 'index.js'), join(pluginRoot, 'index.mjs'))
await copyFile(join(dist, 'client.js'), join(pluginRoot, 'client.js'))
await copyFile(join(dist, 'client.js.map'), join(pluginRoot, 'client.js.map'))
await rm(dist, { recursive: true, force: true })
console.log('build complete: index.mjs + client.js')
