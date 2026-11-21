# Security policy

## Reporting a vulnerability

Please report security issues privately to **support@getraya.app**, with "Security" in the
subject, rather than in a public issue. Include the SDK version, your runtime and a
description or proof of concept. We will acknowledge your report within three working days
and keep you informed until it is resolved.

## Supported versions

Security fixes go into the latest release. During the 1.0 release candidates, that is the
latest `1.0.0-rc.N`.

## Handling API keys

- Keep keys on your server. The SDK refuses to run in a browser unless you pass
  `dangerouslyAllowBrowser: true`, because a key in a web page is visible to anyone using it.
- The SDK never puts the key in error messages, error properties or logs. Where a runtime
  cannot send headers on a WebSocket (browsers, Bun, Deno, Workers), the key goes in the
  WebSocket URL; the SDK redacts it from anything it logs, but proxies you run may log URLs.
- The SDK sends nothing anywhere except the API base URL you configure: no telemetry and no
  update checks.
