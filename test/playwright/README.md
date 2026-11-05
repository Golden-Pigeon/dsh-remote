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
- the global New Session action resolves the current mirrored workspace;
- repeated workspace New Session clicks stay lazy;
- pending blank state survives a plugin disable/enable reload.

`pnpm test:e2e` builds first and uses the system Chrome executable; it does not
download Playwright browsers.
