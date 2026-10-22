// Codex TUI를 가상 터미널로 띄워 화면 글자를 모은다. 인자: 출력 파일, 보낼 키 순서(JSON)
import pty from '@lydell/node-pty';
import fs from 'node:fs';
const [out, keysJson, ...cmd] = process.argv.slice(2);
const keys = JSON.parse(keysJson);
const p = pty.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols: 140, rows: 45, cwd: process.env.PROBE_CWD, env: process.env });
let buf = '';
p.onData((d) => { buf += d; });
for (const [wait, key] of keys) { await new Promise((r) => setTimeout(r, wait)); if (key) p.write(key); fs.writeFileSync(out, buf); }
await new Promise((r) => setTimeout(r, 1500));
fs.writeFileSync(out, buf);
p.kill();
process.exit(0);
