# TruffleHog Caido

A [Caido](https://caido.io/) plugin that pipes intercepted HTTP responses
through the [TruffleHog](https://github.com/trufflesecurity/trufflehog) binary
and turns every detected secret into a Caido **Finding**, attached to the
originating request.

Inspired by the
[TruffleHog Burp Suite extension](https://github.com/trufflesecurity/trufflehog-burp-suite-extension).

![](/assets/image.png?c=123323)

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Install the plugin](#install-the-plugin)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Finding format](#finding-format)
- [Tunables and limits](#tunables-and-limits)
- [Project structure](#project-structure)
- [Development](#development)
- [Releases](#releases)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Features

- **Passive scanning** — every response that flows through Caido is queued
  for analysis, no manual action required.
- **Real TruffleHog detectors** — uses your local `trufflehog` binary, so you
  always get the latest detector list and verification logic.
- **Cross-platform** — built on `os.tmpdir()` and `os.homedir()`; no
  hard-coded macOS/Linux paths.
- **Persistent settings** — binary path and filter live in
  `~/.config/trufflehog-caido/settings.json` and are reloaded on every Caido
  startup, even if the plugin UI is never opened.
- **Binary validation** — the backend runs `trufflehog --version` on startup
  and on every **Save** / **Verify** click; scanning is paused until the
  binary is healthy.
- **Live scanner panel** — Status tab shows binary version, scanner state,
  total findings, pending files, last scan age, and last batch size.
- **`--only-verified` toggle** — surface only secrets that TruffleHog could
  verify against a live service (or include unverified matches if you prefer
  a noisier feed).
- **Bounded resource usage** — response bodies are capped at 1 MB before
  hitting disk, scanned files are deleted as soon as the scan finishes, and
  the in-memory request cache is bounded by both TTL and size.
- **Stable de-duplication** — Findings are keyed by
  `responseId + detector + line + redacted`, so re-scans don't multiply
  entries in the Findings tab.
- **Safe spawning** — the binary is invoked via `spawn(path, argv)` without
  `shell: true`, so the configured path is never interpreted by a shell.

---

## Requirements

- Caido — recent release (tested against `@caido/sdk-backend@^0.46`).
- A local `trufflehog` binary on the same host that runs Caido.
- Node 18+ and [pnpm](https://pnpm.io/) — only needed if you want to build
  the plugin from source.

Install TruffleHog with one of:

```sh
brew install trufflehog
# or
go install github.com/trufflesecurity/trufflehog/v3@latest
# or download a pre-built release:
#   https://github.com/trufflesecurity/trufflehog/releases
```

Verify it runs:

```sh
trufflehog --version
```

---

## Install the plugin

You can install a pre-built package or build it yourself.

### Option A — pre-built package

1. Grab `plugin_package.zip` from a [release](../../releases) (or build it,
   see below).
2. In Caido, open **Plugins → Install Package** and select the `.zip`.
3. Click the **TruffleHog** entry in the sidebar.
4. Open the **Settings** tab, enter the path to your binary (or just
   `trufflehog` if it's on `PATH`), click **Save**, and confirm the **Binary**
   tag turns green on the **Status** tab.

### Option B — build from source

```sh
git clone https://github.com/phor3nsic/trufflehog-caido.git
cd trufflehog-caido
pnpm install
pnpm build
```

The package is written to `dist/plugin_package.zip`. Install it as in
**Option A**.

---

## Configuration

Everything is configured from the **TruffleHog** sidebar entry.

| Setting             | Default       | Description                                                                                                       |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Binary Path**     | `trufflehog`  | Absolute path or PATH-resolvable command. Validated via `trufflehog --version`.                                   |
| **Only verified**   | `on`          | When on, the scanner runs with `--only-verified`, so only secrets TruffleHog could verify live become Findings.   |

Settings are persisted to `~/.config/trufflehog-caido/settings.json` so they
survive Caido restarts, plugin reloads, and even cases where the user never
opens the plugin UI after a fresh install.

The two action buttons:

- **Save** — persists the binary path and immediately runs verification.
- **Verify** — re-runs `trufflehog --version` against the currently saved
  path; useful after upgrading TruffleHog.

---

## How it works

```
                  ┌──────────────────────────────┐
HTTP response ──▶ │ onInterceptResponse callback │
                  └──────────┬───────────────────┘
                             │  write <ts>__<responseId>.txt
                             ▼
       <os.tmpdir>/trufflehog-caido/pending/
                             │
                             │  every ~11s
                             ▼
                  ┌──────────────────────────────┐
                  │ snapshot pending file list   │
                  │ trufflehog filesystem --json │
                  │ map response id ──▶ request  │
                  │ sdk.findings.create(...)     │
                  │ delete files in snapshot     │
                  └──────────────────────────────┘
```

1. **Capture.** `sdk.events.onInterceptResponse` fires for every response.
   The plugin truncates the body to 1 MB and writes it to
   `<os.tmpdir>/trufflehog-caido/pending/<timestamp>__<responseId>.txt`.
   The originating `Request` is kept in an in-memory cache keyed by
   response id (TTL 15 minutes, max 5 000 entries).
2. **Scan.** A timer fires every 11 seconds. If pending files exist and the
   binary is healthy, the scanner snapshots the current file list and runs:

   ```sh
   trufflehog filesystem <pendingDir> --json --no-update [--only-verified]
   ```

3. **Map back.** Each JSON result includes
   `SourceMetadata.Data.Filesystem.file`. The plugin extracts the response
   id from the filename, looks up the original request in the cache, and
   calls `sdk.findings.create(...)` with a stable `dedupeKey`.
4. **Cleanup.** When the TruffleHog process exits, the plugin deletes only
   the files that were in the snapshot. Files written during the scan are
   left for the next tick. This avoids scanning the same response twice and
   keeps `/tmp` bounded.

The runtime is [LLRT](https://github.com/awslabs/llrt) (the JS engine Caido
backends use), which is why the design avoids `fs.rename` and other
Node-only APIs.

---

## Finding format

Each emitted Finding looks like this:

- **Title** — `TruffleHog: <DetectorName> [(verified)]`
- **Reporter** — `TruffleHog`
- **Request** — the originating intercepted request
- **Dedupe key** — `<responseId>-<detector>-<line>-<redacted>`
- **Description** — Markdown:

  ```
  TruffleHog detected a potential secret in a passive HTTP response.

  - Detector: AWS
  - Verified: true
  - Decoder: PLAIN
  - Redacted: AKIAXXXX*****
  - Line: 14

  Raw finding:
  ```json
  { ... full TruffleHog JSON object ... }
  ```
  ```

The raw JSON is included so you can copy/paste detector-specific data
(`ExtraData`, `RawV2`, etc.) without leaving Caido.

---

## Tunables and limits

These are constants in `packages/backend/src/index.ts`. They are intentionally
not configurable from the UI to keep the surface area small — change them in
source if you need different defaults.

| Constant                  | Default              | Meaning                                                            |
| ------------------------- | -------------------- | ------------------------------------------------------------------ |
| `SCAN_INTERVAL_MS`        | `11_000`             | Minimum delay between scan ticks.                                  |
| `RESPONSE_CACHE_TTL_MS`   | `15 * 60 * 1000`     | How long the request cache keeps a response context around.        |
| `RESPONSE_CACHE_MAX`      | `5_000`              | Hard cap on the request cache; oldest entries are evicted first.   |
| `MAX_RESPONSE_BYTES`      | `1_000_000`          | Response bodies are truncated past this size before being scanned. |
| `BINARY_TIMEOUT_MS`       | `10_000`             | Timeout for `trufflehog --version` invocations.                    |

---

## Project structure

```
trufflehog-caido/
├── caido.config.ts                  # Plugin manifest definition
├── packages/
│   ├── backend/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts             # Scanner, settings, findings, API
│   └── frontend/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts             # PrimeVue/Vue bootstrap, sidebar entry
│           ├── plugins/sdk.ts       # Vue plugin that injects FrontendSDK
│           ├── styles/
│           │   ├── caido.css        # Caido CSS variables
│           │   ├── primevue.css     # PrimeVue theme tokens
│           │   └── index.css        # Tailwind entry
│           ├── types.ts             # Frontend SDK type with backend API
│           └── views/App.vue        # Status + Settings UI
├── eslint.config.mjs
├── knip.ts
├── tsconfig.json
├── pnpm-workspace.yaml
├── package.json
└── dist/                            # Build output (git-ignored)
```

The exposed backend API is defined in `packages/backend/src/index.ts`:

```ts
export type API = DefineAPI<{
  setBinaryPath: typeof setBinaryPath;     // (path) => VerifyResult
  setOnlyVerified: typeof setOnlyVerified; // (boolean) => void
  getSettings: typeof getSettings;         // () => Settings
  getStats: typeof getStats;               // () => Stats
  verifyBinary: typeof verifyBinary;       // () => VerifyResult
}>;
```

---

## Development

```sh
pnpm install      # install workspace dependencies
pnpm watch        # rebuild backend + frontend on file change
pnpm build        # produces dist/plugin_package.zip
pnpm typecheck    # tsc + vue-tsc across both packages
pnpm lint         # eslint --fix
pnpm knip         # detect unused deps / exports
```

Stack:

- [pnpm](https://pnpm.io/) workspace
- [TypeScript](https://www.typescriptlang.org/) on both sides
- Backend runs on [LLRT](https://github.com/awslabs/llrt) inside Caido
- Frontend uses [Vue 3](https://vuejs.org/) + [PrimeVue 4](https://primevue.org/) +
  [Tailwind CSS](https://tailwindcss.com/) (Caido theme via `@caido/tailwindcss`
  and `@caido/primevue`)

The frontend follows the
[official Caido plugin pattern](https://developer.caido.io/concepts/frontend/ui.html):
PrimeVue components (`Card`, `Tabs`, `Tag`, `Message`, `ToggleSwitch`,
`Button`, `InputText`) styled with `bg-surface-*` / `text-surface-*` Tailwind
tokens. User feedback uses `sdk.window.showToast` instead of custom status
bars.

---

## Releases

Two GitHub Actions workflows live in `.github/workflows/`:

| Workflow        | Trigger                                                                 | What it does                                                                                                                            |
| --------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `validate.yml`  | Every push and PR to `main`                                             | Runs `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Uploads `plugin_package.zip` as a build artifact (kept 7 days).                   |
| `release.yml`   | Push of a tag matching `v*`, or manual `workflow_dispatch`              | Builds, optionally signs the package, and publishes a GitHub Release with `plugin_package.zip` (and `.sig` if signing) attached.        |

### Cutting a release

```sh
# 1. Bump the version in caido.config.ts (e.g. 0.1.0 → 0.2.0).
# 2. Commit and push.
git commit -am "Release v0.2.0"
git push

# 3. Tag and push the tag — this triggers the release workflow.
git tag v0.2.0
git push origin v0.2.0
```

The workflow:

1. Installs dependencies with `--frozen-lockfile`.
2. Runs `pnpm build`, producing `dist/plugin_package.zip`.
3. Reads the version from the bundled `manifest.json` for sanity.
4. Optionally signs the zip with an ed25519 key (see below).
5. Creates a GitHub Release named after the tag, with auto-generated release
   notes and the package attached.

You can also trigger it manually from the **Actions** tab via
`workflow_dispatch`; if you don't pass a tag input, the release is named
`v<manifest.version>`.

### Optional package signing

If you want signed packages, generate an ed25519 key and store the PEM as the
repository secret `PRIVATE_KEY`:

```sh
openssl genpkey -algorithm ed25519 -out private_key.pem
openssl pkey -in private_key.pem -pubout -out public_key.pem  # share this
gh secret set PRIVATE_KEY < private_key.pem
```

When the secret is present the release workflow produces and attaches
`plugin_package.zip.sig`. When it isn't, signing is skipped silently — the
unsigned zip still ships.

---

## Troubleshooting

### `Binary` tag stays red

Open the **Settings** tab and click **Verify**. The error message under the
input shows the failure reason (typical causes: file not executable, wrong
path, missing libc dependency on Linux).

If you can run `trufflehog --version` from the same shell that started Caido
but the plugin can't, you most likely need to use an absolute path —
graphical launchers (Spotlight, GNOME, Windows Start menu) often don't
inherit your shell's `PATH`.

### No findings appear

1. Check the **Pending** counter on the Status tab — it should grow as you
   browse.
2. Check the **Last scan** counter — it should refresh every ~11 seconds once
   pending files exist.
3. Confirm `Only verified` is off if you're testing with a non-verifiable
   detector (most third-party API keys).
4. Look at the Caido backend log for `[TruffleHog]` lines.

### Settings don't stick

The plugin writes to `~/.config/trufflehog-caido/settings.json`. If that
directory is not writable (e.g., Caido sandbox, read-only home), settings
will reset on every reload. Fix the permissions or run Caido under a user
that can write there.

### Disk fills up

The plugin only ever holds files for one scan window. If you see a growing
`<os.tmpdir>/trufflehog-caido/pending/` directory, the scanner timer is not
firing — usually because the binary is unhealthy. Fix the binary status and
the next tick will drain the queue.

---

## Security notes

- The binary path is invoked via `spawn(path, argv)` with `shell: false`.
  The configured path is **never** concatenated into a shell command, so
  there is no shell-injection surface even if the user pastes a weird path.
- Response bodies live in `<os.tmpdir>/trufflehog-caido/pending/` for at
  most one scan window. They are written with the default umask of the
  Caido process. If your threat model objects to that, mount the tmpdir on
  an encrypted filesystem.
- `~/.config/trufflehog-caido/settings.json` only contains the binary path
  and the `onlyVerified` flag — no secrets.
- Findings include a `Redacted` value (first 8 characters + `*****`) and the
  full TruffleHog JSON. The Caido Findings tab is shared with the project,
  so be mindful of who has access if the **Only verified** toggle is off.

---

## Acknowledgements

- [TruffleHog](https://github.com/trufflesecurity/trufflehog) by
  [Truffle Security](https://trufflesecurity.com/) — does all the actual
  detection work.
- The [TruffleHog Burp Suite extension](https://github.com/trufflesecurity/trufflehog-burp-suite-extension) — direct inspiration for this plugin.
- The [Caido team](https://caido.io/) and the
  [caido-community](https://github.com/caido-community) plugin examples.

---

## License

[MIT](LICENSE) — © DeepLook Labs
