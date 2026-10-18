# @dsh-remote/protocol

The shared wire contract for `dsh-remote` (reads and writes):

- protocol revision negotiation;
- JSON envelopes and stable error codes;
- host/workspace/session/event types;
- cursor rules (`applied` / `duplicate` / `gap`);
- an SSE parser;
- a validated `RemoteAgentClient` over `fetch`.

It has no runtime dependencies and imports no DSH packages, so the same code is used by the local
plugin (bundled), the installer, the testkit, and the contract tests.

```ts
const client = new RemoteAgentClient({
  baseUrl: 'http://127.0.0.1:41234',
  token: await readToken(),
  hostId: 'example-host-gpu',
})
const health = await client.health()
const workspaces = await client.listWorkspaces()
const workspace = await client.createWorkspace({ path: '/home/me/project' })
const session = await client.createSession({ workspaceId: workspace.workspaceId })
await client.promptSession(session.sessionId, { text: 'Summarize this project' })
const snapshot = await client.snapshotSession(session.sessionId, { limit: 200 })
for await (const frame of client.followSession(sessionId, snapshot.cursor, signal)) {
  // ready | event | heartbeat | end
}
```

See [`docs/protocol.md`](../../docs/protocol.md) for the full wire reference.
