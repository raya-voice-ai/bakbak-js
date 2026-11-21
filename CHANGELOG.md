# Changelog

All notable changes to this package are documented here. The format follows
[Conventional Commits](https://www.conventionalcommits.org/) and the file is maintained by
release-please.

## 1.0.0-rc.1 (2026-11-21)

First release candidate of the official JavaScript and TypeScript SDK for the Bakbak
text-to-speech API, implementing version 1 of the shared client behaviour
(`conformance/BEHAVIOR.md`).

### Features

- `new Bakbak()` with `apiKey`/`BAKBAK_API_KEY`, `baseURL`/`BAKBAK_BASE_URL`, read timeout,
  retries, default headers, a custom `fetch`, a logger and `dangerouslyAllowBrowser`.
- `client.tts.generate()`: whole files, as an `Audio` with `toWav()` and `save()`.
- `client.tts.stream()`: Server-Sent Events streaming as an `AudioStream` (async iterable,
  `bytes()`, `arrayBuffer()`, `toAudio()`, `toReadableStream()`, `requestId`).
- `client.tts.websocket()`: many requests on one connection in ordered contexts, with
  `send()`, `sendStream()` for LLM tokens, `endInput()`, `cancel()`, `events()`, `audio()`,
  back-pressure, and reconnects that never replay audio.
- `client.voices.list()` with client-side `model` and `language` filters.
- `splitSentences()` and the streaming `Segmenter`, matching the reference segmenter.
- `toWav()` for raw `pcm_s16le`, `pcm_f32le`, `pcm_mulaw` and `pcm_alaw` audio.
- The error hierarchy of the behaviour spec, with `instanceof` across ESM and CommonJS.
- Node 20+, Bun, Deno, Cloudflare Workers and browsers; zero runtime dependencies, with `ws`
  as an optional peer dependency on Node.
