# Changelog

All notable changes to this package are documented here. The format follows
[Conventional Commits](https://www.conventionalcommits.org/) and the file is maintained by
release-please.

## [1.0.0-rc.3](https://github.com/raya-voice-ai/bakbak-js/compare/v1.0.0-rc.2...v1.0.0-rc.3) (2026-11-21)


### Bug Fixes

* **release:** leave the changelog release-please writes out of the formatter check ([a4df6fa](https://github.com/raya-voice-ai/bakbak-js/commit/a4df6fabe8de4bc098ab05996a993a4ac7de98e0))

## [1.0.0-rc.2](https://github.com/raya-voice-ai/bakbak-js/compare/v1.0.0-rc.1...v1.0.0-rc.2) (2026-11-21)


### Features

* add the client with generate, SSE streaming and voices ([6367b5e](https://github.com/raya-voice-ai/bakbak-js/commit/6367b5ef50f437513a73bf0ba5b8ca4f55dffbf0))
* add the sentence segmenter and LLM token extraction ([552f7cf](https://github.com/raya-voice-ai/bakbak-js/commit/552f7cf126d1095cbe3dd5f1f897e72f6c66fbfd))
* add the WebSocket client with contexts ([e85e82b](https://github.com/raya-voice-ai/bakbak-js/commit/e85e82b7b71535236620f12273ec8d5f7ae61006))


### Bug Fixes

* accept only delay seconds or an HTTP date in Retry-After ([e3b4944](https://github.com/raya-voice-ai/bakbak-js/commit/e3b4944be7be5e28cccc04186f125ff9a55e5a13))
* fail only its own request on a chunk that is not valid base64 ([3b2d723](https://github.com/raya-voice-ai/bakbak-js/commit/3b2d72313497c172619411d814ffff66c009ec52))
* guard and unref timers, and add a watchdog for unsent requests ([b643258](https://github.com/raya-voice-ai/bakbak-js/commit/b6432587d66efc96b3e1e4acb76e68e7b985186a))
* report unknown stream metadata as unknown, and refine detail rendering ([6993d3a](https://github.com/raya-voice-ai/bakbak-js/commit/6993d3aaa2823d6045c76edd678f876442cde06d))
* **segmenter:** keep look-behind text when trimming the stream buffer ([bdc766f](https://github.com/raya-voice-ai/bakbak-js/commit/bdc766fbae7689c1ca84e8a1a6fff3c60d57207b))
* **stream:** abort at once when the reader cancels ([44e69cf](https://github.com/raya-voice-ai/bakbak-js/commit/44e69cfdb23946c29ebc306dfa22dd5bec08ede0))
* **ws:** free consumed audio and release idle contexts ([1002ab2](https://github.com/raya-voice-ai/bakbak-js/commit/1002ab2d91ed554d601fd85bbe79809711db7437))
* **ws:** log the redacted URL actually used by the global WebSocket ([2c589df](https://github.com/raya-voice-ai/bakbak-js/commit/2c589dfc6f9a886b1941c76a05a6099941491205))
* **ws:** make cancel() silence the whole context and stop sendStream ([9be7177](https://github.com/raya-voice-ai/bakbak-js/commit/9be717701821519db746ee2b3249ae4844a3860b))
* **ws:** move to a new connection as soon as a drain refusal arrives ([2be72ee](https://github.com/raya-voice-ai/bakbak-js/commit/2be72eea7ed713cab6963aeda51fe3916a934422))
* **ws:** never wait more than a second to close a drained connection ([a959411](https://github.com/raya-voice-ai/bakbak-js/commit/a959411c0e627af80925d28be1cebe6b816d2aab))
* **ws:** stop drain storms and hangs after a drain ([69090cd](https://github.com/raya-voice-ai/bakbak-js/commit/69090cdcc4cd719c5b03c732b4a8ab9803f30fc0))


### Performance Improvements

* **segmenter:** bound the streaming look-behind as the reference does ([d4c75c0](https://github.com/raya-voice-ai/bakbak-js/commit/d4c75c049f0313af67e5f31c6654a97a0b9f184a))
* **segmenter:** segment in linear time and keep surrogate pairs whole ([b5f289b](https://github.com/raya-voice-ai/bakbak-js/commit/b5f289bbf6255ae6a115ffdb0d54adc57173d1da))
* **sse:** parse huge lines in linear time ([aaac27b](https://github.com/raya-voice-ai/bakbak-js/commit/aaac27b10a824eb4ae0bbb5b741836360d9c1259))

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
