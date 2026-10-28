import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EN_DELETE_REPLACEMENT,
  EN_DELETE_SUFFIX,
  ZH_DELETE_REPLACEMENT,
  ZH_DELETE_SUFFIX,
  rewriteWorkspaceDeleteCopy,
} from '../src/client/workspace-delete-copy.ts'

describe('mirrored workspace delete copy', () => {
  const titles = new Set(['lab · data-transfer'])

  it('rewrites the English sentence for a mirrored workspace', () => {
    const text = `This removes “lab · data-transfer” from the workspace list. The folder and session logs will be kept. ${EN_DELETE_SUFFIX}`
    assert.equal(
      rewriteWorkspaceDeleteCopy(text, titles),
      `This removes “lab · data-transfer” from the workspace list. The folder and session logs will be kept. ${EN_DELETE_REPLACEMENT}`,
    )
  })

  it('rewrites the Chinese sentence for a mirrored workspace', () => {
    const text = `将把“lab · data-transfer”从工作区列表中移除。文件夹与会话记录会保留，${ZH_DELETE_SUFFIX}`
    assert.equal(
      rewriteWorkspaceDeleteCopy(text, titles),
      `将把“lab · data-transfer”从工作区列表中移除。文件夹与会话记录会保留，${ZH_DELETE_REPLACEMENT}`,
    )
  })

  it('leaves native workspaces and unknown copy alone', () => {
    assert.equal(
      rewriteWorkspaceDeleteCopy(`This removes “local-project” from the workspace list. ${EN_DELETE_SUFFIX}`, titles),
      undefined,
    )
    assert.equal(rewriteWorkspaceDeleteCopy('unrelated modal copy', titles), undefined)
  })
})
