import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RemoteUiError } from '../src/client/api.ts'
import { formatUiText, localizedError } from '../src/client/errors.ts'
import { en, zh, type CopyKey } from '../src/client/locale.ts'
import { toHostView, idleRuntime, type HostRecord } from '../src/hosts/types.ts'
import { HOST_DETAILS, UI_TEXT_KEYS, uiForErrorCode } from '../src/messages.ts'

const t = (key: CopyKey): string => zh[key]

describe('plugin localization', () => {
  it('has both dictionaries for every host status and UI message key', () => {
    for (const detail of HOST_DETAILS) {
      assert.ok(`detail.${detail}` in zh, `missing zh detail.${detail}`)
      assert.ok(`detail.${detail}` in en, `missing en detail.${detail}`)
    }
    for (const key of UI_TEXT_KEYS) {
      assert.ok(key in zh, `missing zh ${key}`)
      assert.ok(key in en, `missing en ${key}`)
    }
  })

  it('localizes errors by stable UI key without leaking the raw host message', () => {
    const failure = new RemoteUiError('agent/unavailable', '远端自动安装失败：中文原始错误', {}, { key: 'error.agentUnavailable' })
    assert.equal(localizedError(t, failure, zh['error.unknown']), zh['error.agentUnavailable'])
    assert.notEqual(localizedError(t, failure, zh['error.unknown']), failure.message)
    assert.equal(localizedError(t, new RemoteUiError('host/invalid', 'raw'), zh['error.unknown']), zh['error.hostInvalid'])
    assert.equal(localizedError(t, new Error('raw'), zh['error.operationFailed']), zh['error.operationFailed'])
    assert.equal(
      formatUiText(t, { key: 'error.agentVersionMismatch', params: { expected: '0.2.10', actual: '0.2.9' } }),
      '远端 agent 版本不匹配（期望 0.2.10，实际 0.2.9）。请检查远端 profile 或安装日志。',
    )
  })

  it('maps local error codes to stable keys', () => {
    assert.equal(uiForErrorCode('ssh/tunnel-failed').key, 'error.sshTunnelFailed')
    assert.equal(uiForErrorCode('unknown/code').key, 'error.internal')
  })

  it('projects structured status and localized error fields into HostView', () => {
    const record: HostRecord = {
      id: 'h1', label: 'host', sshTarget: 'user@host', sshPort: null,
      remoteAgentPort: 1234, token: 'secret', autoConnect: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const view = toHostView(record, {
      ...idleRuntime(),
      phase: 'connected',
      detail: 'connectedDirect',
      agentOutdated: true,
      error: 'raw host error',
      errorCode: 'agent/unavailable',
      errorUi: { key: 'error.agentUnavailable' },
    })
    assert.equal(view.detail, 'connectedDirect')
    assert.equal(view.agentOutdated, true)
    assert.deepEqual(view.errorUi, { key: 'error.agentUnavailable' })
  })
})
