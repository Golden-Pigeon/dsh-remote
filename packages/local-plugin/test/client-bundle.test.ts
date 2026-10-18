import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

interface LoadedModule {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

async function loadClientBundle(): Promise<LoadedModule> {
  const file = join(process.cwd(), 'lib', 'client.js')
  const code = await readFile(file, 'utf8')
  let loaded: LoadedModule | undefined
  const sandbox = {
    window: {
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

describe('client bundle artifact', () => {
  it('registers the package and a Settings section', async () => {
    const loaded = await loadClientBundle()
    assert.equal(loaded.id, 'dsh-remote-local-plugin')
    const exports = loaded.factory((specifier) => {
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`unexpected external: ${specifier}`)
    })
    assert.deepEqual(Array.from(exports.inject as string[]), ['slots', 'uiWorkspace'])
    assert.equal(typeof exports.apply, 'function')

    let registration: { name: string; id: string; label: string; order: number; inject: () => { api: unknown } } | undefined
    let component: unknown
    const ctx = {
      slots: {
        inject: (_key: string, callback: () => () => void) => callback(),
        register: (options: typeof registration, entry: unknown) => {
          registration = options
          component = entry
          return () => undefined
        },
      },
    }
    ;(exports.apply as (context: unknown) => void)(ctx)
    assert.ok(registration)
    assert.equal(registration.name, 'settings.section')
    assert.equal(registration.id, 'remote-development')
    assert.equal(registration.label, '远程开发')
    assert.equal(registration.order, 76)
    assert.equal(typeof component, 'function')

    const injected = registration.inject() as { api: { state: () => Promise<unknown> } }
    assert.equal(typeof injected.api.state, 'function')
  })
})
