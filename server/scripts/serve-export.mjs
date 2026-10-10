import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const root = path.resolve(process.argv[2] || '../build');
const port = Number(process.argv[3] || 8806);
const types = {'.html':'text/html', '.js':'text/javascript', '.wasm':'application/wasm', '.pck':'application/octet-stream', '.png':'image/png', '.svg':'image/svg+xml'};
http.createServer((request,response) => {
  const url = new URL(request.url, 'http://localhost');
  let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  fs.stat(file, (error,stat) => {
    if (error || !stat.isFile()) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    response.setHeader('Content-Length', stat.size);
    response.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(response);
  });
}).listen(port, '127.0.0.1', () => console.log(`Game export: http://127.0.0.1:${port}/web/index.html`));
