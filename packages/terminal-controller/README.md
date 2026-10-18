# dsh-remote-terminal-controller

Profile-level fork of `@deepseek-ai/dsh-api-terminal-controller`.

- Host half re-exports the stock `TerminalController`.
- Client half constructs `ClientTerminals` with a Session-routing remote face:
  - local Sessions keep the stock local PTY controller;
  - mirrored remote Sessions use `/api/dsh-remote-terminal` (SSH PTY).
- The bundle patch replaces the stock `terminal-controller` row in the selected DSH profile.
