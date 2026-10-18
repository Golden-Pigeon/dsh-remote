# @dsh-remote/testkit

An in-memory fake remote host implementing the `dsh-remote-agent` wire contract.

```ts
import { startFakeHost } from '@dsh-remote/testkit'
import { RemoteAgentClient } from '@dsh-remote/protocol'

const { host, baseUrl } = await startFakeHost({ token: 'test-token-0123456789' })
const client = new RemoteAgentClient({ baseUrl, token: host.token })
assert.equal((await client.health()).workspaceCount, 2)
await host.stop()
```

Features:

- deterministic workspaces and sessions;
- snapshot with limit/truncation;
- SSE replay from a cursor;
- `appendEvent()` pushes live events to open streams;
- auth, protocol-version, and not-found failures;
- request log for assertions.

Use it for protocol contract tests, local plugin integration tests without SSH, and UI fixtures. See
[`test/contract.test.ts`](test/contract.test.ts).
