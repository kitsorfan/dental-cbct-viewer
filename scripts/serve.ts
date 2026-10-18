// Zero-dependency static server for development: node scripts/serve.ts [port]
// TypeScript sources are served as JavaScript with their types stripped.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8080;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file: string;
  try {
    file = path.join(root, decodeURIComponent(url.pathname));
  } catch {
    res.writeHead(400).end(); // malformed percent-encoding
    return;
  }
  // root + separator, so that a sibling folder whose name starts like this one stays out of reach.
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    const ext = path.extname(file);
    let out: Buffer | string = body;
    if (ext === '.ts') {
      try {
        out = stripTypeScriptTypes(body.toString('utf8'));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(e));
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(out);
  });
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
