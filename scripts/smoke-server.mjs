// A small mock of the Bakbak API for runtime smoke tests (scripts/smoke-runtime.mjs).
// Prints "PORT=<n>" once listening; exits on SIGTERM or after 120 s.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const KEY = 'test-key';
const pcm = Buffer.alloc(3200, 1); // 0.1 s of 16 kHz s16
const b64 = pcm.toString('base64');

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    if (req.headers['x-api-key'] !== KEY)
      return json(res, 401, { message: 'Unauthorized', request_id: 'gw' });
    const ua = req.headers['user-agent'] ?? '';
    const headers = { 'x-request-id': 'req_smoke', 'x-smoke-user-agent': ua };
    if (req.method === 'GET' && req.url === '/v1/voices') {
      return json(
        res,
        200,
        { voices: [{ id: 'v1', name: 'Anika M1', language: 'hi', model: 'm1' }], count: 1 },
        headers,
      );
    }
    const params = JSON.parse(body || '{}');
    if (params.voice_id === 'missing') {
      return json(
        res,
        404,
        { error_code: 'voice_not_found', message: 'No such voice.', retryable: false },
        headers,
      );
    }
    if (req.url === '/v1/text-to-speech') {
      res.writeHead(200, {
        ...headers,
        'content-type': 'audio/pcm',
        'x-audio-format': 'pcm_s16le',
        'x-audio-sample-rate': '16000',
      });
      return res.end(pcm);
    }
    if (req.url === '/v1/text-to-speech/stream') {
      res.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream',
        'x-audio-format': 'pcm_s16le',
        'x-audio-sample-rate': '16000',
      });
      const chunk = `event: chunk\ndata: {"type":"chunk","status_code":206,"done":false,"data":"${b64}"}\n\n`;
      return res.end(`${chunk}${chunk}event: done\ndata: {"type":"done","status_code":200,"done":true}\n\n`);
    }
    json(res, 404, { message: 'no Route matched with those values' });
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const viaHeader = req.headers['x-api-key'] === KEY;
  const viaQuery = url.searchParams.get('X-API-Key') === KEY;
  if (url.pathname !== '/v1/text-to-speech/ws' || !(viaHeader || viaQuery)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const base = { context_id: msg.context_id, request_id: viaHeader ? 'req_header' : 'req_query' };
      ws.send(JSON.stringify({ type: 'chunk', status_code: 206, done: false, data: b64, ...base }));
      ws.send(JSON.stringify({ type: 'done', status_code: 200, done: true, ...base }));
    });
  });
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  console.log(`PORT=${server.address().port}`);
});
const stop = () => {
  for (const c of wss.clients) c.terminate();
  server.closeAllConnections();
  server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
setTimeout(stop, 120_000).unref();
