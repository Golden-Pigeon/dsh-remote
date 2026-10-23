import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { abandonedTurnEnd } from '../src/mirror/recovery.ts'

describe('abandonedTurnEnd', () => {
  it('does not close a prompt that has not opened a turn yet', () => {
    assert.equal(abandonedTurnEnd(undefined, 7), undefined)
    assert.equal(abandonedTurnEnd({}, 7), undefined)
    assert.equal(abandonedTurnEnd({ openTurnStartSeq: 'not-a-seq' }, 7), undefined)
  })

  it('closes the open local turn as disposed', () => {
    assert.deepEqual(abandonedTurnEnd({ openTurnStartSeq: 12 }, 7), {
      turn: 7,
      reason: { kind: 'aborted', reason: { kind: 'disposed' } },
    })
  })
})
