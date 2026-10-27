import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'

export interface LoadedModule {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

export async function loadClientBundle(surfaces: Record<string, unknown> = {}): Promise<LoadedModule> {
  const file = join(process.cwd(), 'lib', 'client.js')
  const code = await readFile(file, 'utf8')
  let loaded: LoadedModule | undefined
  const sandbox = {
    ...surfaces,
    window: {
      ...(surfaces.window as object | undefined),
      __ModuleLoader__: {
        load: (entry: LoadedModule) => { loaded = entry },
      },
    },
    console,
  }
  vm.runInNewContext(code, sandbox, { filename: file })
  assert.ok(loaded, 'client bundle did not call window.__ModuleLoader__.load')
  return loaded
}

