// 앞단 시험용 가짜 Node 서버: `node fake_node.mjs --socket <경로>`. 환경 변수 FAKE_NODE_MODE로 동작을 바꾼다
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const socket = args[args.indexOf('--socket') + 1];
const mode = process.env.FAKE_NODE_MODE ?? 'ok';
if (process.env.FAKE_NODE_PID_FILE) writeFileSync(process.env.FAKE_NODE_PID_FILE, String(process.pid));
if (mode === 'exit-early') process.exit(3);

const server = createServer((req, res) => {
  if (req.url === '/api/health') {
    res.statusCode = mode === 'never-ready' ? 503 : 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', app: 'b-studio' }));
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ url: req.url, headers: req.headers, rawHeaders: req.rawHeaders }));
});
server.listen(socket, () => {
  console.log(`가짜 node가 소켓에서 듣습니다: ${socket}`);
  if (mode === 'die-after-ready') setTimeout(() => process.exit(7), 1500);
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
