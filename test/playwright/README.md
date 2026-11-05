# Playwright E2E

These tests boot an isolated DSH Web host with a temporary `DSH_HOME`, a fake
remote agent (`@dsh-remote/testkit`), and a fake `ssh` binary. They do not use
the user's profile, SSH hosts, or remote DSH.

## Prerequisites

- macOS
- official DSH Desktop app installed at `/Applications/DeepSeek Harness.app`
- Google Chrome at `/Applications/Google Chrome.app`
- `pnpm build`/`pnpm test:e2e`

## Run

```sh
pnpm test:e2e
```

The suite creates and removes its temporary home/profile. It installs the
current local plugin tarball into the temporary profile, then verifies:

- the native blank-session mode menu and PTC selection;
- native model selection (DeepSeek-V4-Pro) is forwarded on the first prompt;
- no remote Session create before the first prompt;
- first prompt creates the remote Session with the selected preset;
- the global New Session action resolves the current mirrored workspace and
  first creates a successful `host/session/blank`;
- repeated workspace New Session clicks stay lazy;
- separate unsent drafts for two Workspaces stay isolated;
- a local Workspace New Session keeps the native path and never calls
  `host/session/blank`;
- creating a new remote workspace through the real Add workspace dialog and
  opening it through the workspace `+` action succeeds;
- deleting a mirrored workspace through the native workspace actions removes
  the local workspace;
- a failed native promotion retry reuses the same remote Session and does not
  create a second one;
- a disconnected host rejects the workspace `+` action without creating a
  local blank;
- two simultaneously open windows produce exactly one claim for one promoted
  mirror;
- a DSH-created native blank after host restart is promoted on its first prompt.

## Coverage policy

Every new user-visible remote-session action should add or update a Playwright
case here when it can be exercised through the real DSH Web host. A unit test is
not a substitute for the host/client integration path. If a behavior cannot be
covered deterministically through Playwright (for example real SSH transport,
subagent UI construction, or raw DSH event-scope dispatch), keep the closest
unit/integration test and document the gap in the PR/README.

Assertions must verify the result, not only that a request happened. In
particular, `host/session/blank` assertions check `response.ok()`, and retry
tests assert remote Session identity and accepted prompt counts.

`pnpm test:e2e` builds first and uses the system Chrome executable; it does not
download Playwright browsers.
