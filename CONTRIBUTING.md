# Contributing

Thank you for helping improve the Bakbak JavaScript SDK.

## Development setup

You need Node 20 or newer (CI tests 20, 22 and 24).

```sh
npm ci
npm run lint        # Biome: lint and formatting (npm run format fixes)
npm run typecheck   # tsc, strict
npm test            # unit tests and every conformance scenario
npm run test:dist   # builds, then smoke-tests dist/ (CJS require, ESM import)
npm run check:package  # publint and Are The Types Wrong
npm run check:size  # the browser bundle stays under 20 KB gzipped, without ws
```

`npm run check` runs all of them.

### Layout

| Path                                     |                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `src/client.ts`                          | `Bakbak`, configuration                                                    |
| `src/core/`                              | errors, HTTP attempts and timeouts, SSE parsing, base64, runtime detection |
| `src/resources/`                         | `client.tts` (`generate`, `stream`, `websocket`) and `client.voices`       |
| `src/stream.ts`, `src/audio.ts`          | `AudioStream`, `Audio`, `toWav`                                            |
| `src/ws/`                                | the WebSocket client: transport selection and the session engine           |
| `src/text/`                              | the sentence segmenter and LLM token extraction                            |
| `test/conformance/`                      | runs `conformance/http` and `conformance/ws` against real local servers    |
| `test/unit/`, `test/dist/`, `test/live/` | unit, built-package and live tests                                         |
| `examples/`                              | runnable examples (`npx tsx examples/quickstart.ts`)                       |

### Live tests

Live tests call a real deployment and spend credits. They are skipped unless both variables
are set, and they run one at a time:

```sh
BAKBAK_API_KEY=… BAKBAK_BASE_URL=https://… npm run test:live
```

Set `BAKBAK_LIVE_WEBSOCKET=0` for a deployment without the WebSocket endpoint. Never commit
keys, `.env` files, hostnames of non-public deployments or customer text.

### Other runtimes

`scripts/smoke-runtime.mjs` exercises the built package on Node, Bun or Deno against the mock
in `scripts/smoke-server.mjs`; CI runs it on Bun and Deno.

## The conformance suite

`conformance/` is shared by every official Bakbak client (Python, JavaScript, the MCP server
and the LiveKit plugin) and is synced from one canonical copy. **Do not edit it here.**

- `BEHAVIOR.md` is the behaviour specification; the fixtures check it.
- To update, copy the canonical directory over `conformance/` unchanged, check it with
  `npm run check:manifest`, and commit it alone as `chore: sync conformance`. Then change
  the SDK until `npm test` passes.
- CI verifies `MANIFEST.sha256`, and a weekly job warns if another client's copy differs.
- If a fixture looks wrong, do not weaken the test: raise it against the canonical copy.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
`test:`, `ci:`, `chore:`); release notes and version numbers are derived from them. Keep
commits small, and keep `npm test` passing on each one. Public names (`Bakbak`, the methods
of `client.tts`, `client.voices`, contexts and the error classes) change only in a major
version.

## Releases

1. Merging to `main` lets [release-please](https://github.com/googleapis/release-please)
   open or update a release pull request with the next version and the changelog.
2. Merging that pull request tags the release and creates a GitHub release.
3. The same workflow (`.github/workflows/release.yml`) then publishes to npm with
   provenance, through npm trusted publishing (OIDC; no npm token is stored).
   Stable versions are published under the `latest` dist-tag. Pre-releases (`1.0.0-rc.N`)
   take `latest` too until a stable version exists, so `npm install bakbak` gets the newest
   one; after that they go under `next`.

The package is in release candidates until 1.0.0: each release bumps `-rc.N`. To release
1.0.0, merge a commit whose message has the footer `Release-As: 1.0.0`.

One-time setup on npmjs.com: add a trusted publisher for this repository with the workflow
`release.yml`.
