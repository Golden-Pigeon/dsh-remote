import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveLoginShell } from '../src/terminal.ts'

describe('remote login shell', () => {
  it('prefers the passwd shell, then $SHELL, then bash', () => {
    const executable = (path: string): boolean => path !== '/missing' && path !== '/missing-shell'
    assert.equal(resolveLoginShell({ SHELL: '/bin/bash' } as NodeJS.ProcessEnv, '/bin/zsh', executable), '/bin/zsh')
    assert.equal(resolveLoginShell({ SHELL: '/bin/zsh' } as NodeJS.ProcessEnv, '/missing', executable), '/bin/zsh')
    assert.equal(resolveLoginShell({ SHELL: '/missing-shell' } as NodeJS.ProcessEnv, '/missing', executable), '/bin/bash')
    assert.equal(resolveLoginShell({ SHELL: 'zsh' } as NodeJS.ProcessEnv, '', executable), '/bin/bash')
    assert.equal(resolveLoginShell({} as NodeJS.ProcessEnv, '', executable), '/bin/bash')
  })
})
