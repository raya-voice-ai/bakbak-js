// Run as a child process by test/unit/timers.test.ts: start a stream, never read it, and let
// the server go away. The process must then exit on its own, without waiting for the SDK's
// read-timeout timer.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Bakbak } from '../../src/index';

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: {"type":"chunk","data":"AAAAAA=="}\n\n');
});
await new Promise<void>((r) => server.listen(0, r));
const client = new Bakbak({
  apiKey: 'k',
  baseURL: `http://localhost:${(server.address() as AddressInfo).port}`,
  timeout: 30_000,
});
client.tts.stream({ text: 'x', voice_id: 'v', language: 'hi' });
await new Promise((r) => setTimeout(r, 200));
server.closeAllConnections();
server.close();
