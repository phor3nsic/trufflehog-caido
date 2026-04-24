# TruffleHog Caido

Caido plugin that pipes intercepted HTTP responses through the
[TruffleHog](https://github.com/trufflesecurity/trufflehog) binary and emits
findings for any detected secrets.

Inspired by the
[TruffleHog Burp Suite extension](https://github.com/trufflesecurity/trufflehog-burp-suite-extension).

![](/assets/image.png)

## Requirements

- Caido (latest release).
- A local `trufflehog` binary on the host running Caido.

Install TruffleHog with one of:

```sh
brew install trufflehog
# or
go install github.com/trufflesecurity/trufflehog/v3@latest
# or download a release from https://github.com/trufflesecurity/trufflehog/releases
```

## Install the plugin

1. Build the package (or download `dist/plugin_package.zip` from a release).
2. In Caido, open **Plugins → Install Package** and pick the `.zip`.
3. Open the **TruffleHog** entry in the sidebar.
4. Enter the full path to the binary (or just `trufflehog` if it is on `PATH`),
   click **Save**, and confirm the **Binary** status turns green.

Settings are persisted to `~/.config/trufflehog-caido/settings.json`, so they
survive Caido restarts and frontend reloads.

## How it works

- Every intercepted HTTP response is written to a short-lived file in
  `<os.tmpdir>/trufflehog-caido/pending/`.
- Every ~11 seconds the pending directory is atomically swapped to a
  `scanning-<id>/` directory, TruffleHog scans it in `filesystem` mode with
  `--json`, and the directory is removed afterwards.
- Each JSON finding is mapped back to the originating request via the response
  id encoded in the filename, and a Caido **Finding** is created with a stable
  `dedupeKey`.

## Features

- Multi-platform: uses `os.tmpdir()` and `os.homedir()`, no hard-coded paths.
- Backend validates the binary (`trufflehog --version`) on save and on startup.
- UI shows live scanner state: binary status, pending files, total findings,
  last scan age, batch size.
- `--only-verified` filter toggle.
- Response bodies are capped at 1 MB before scanning.
- Scanned files are deleted immediately; no unbounded disk growth.
- No `shell: true` when spawning the binary — path is passed as argv, not
  concatenated into a shell command.

## Development

```sh
pnpm install
pnpm watch       # live rebuild
pnpm build       # produces dist/plugin_package.zip
pnpm typecheck
pnpm lint
```

- [pnpm](https://pnpm.io/) workspace
- [TypeScript](https://www.typescriptlang.org/) backend and frontend
- [Vue 3](https://vuejs.org/) + [PrimeVue](https://primevue.org/) for the UI
