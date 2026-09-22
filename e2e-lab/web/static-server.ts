import * as path from 'node:path';

const clientDir = path.resolve(import.meta.dir, '../../client');
const distDir = path.join(clientDir, 'dist');
const port = Number(process.env.CLIENT_WEB_PORT || '8081');

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

if (!(await Bun.file(path.join(distDir, 'index.html')).exists())) {
  throw new Error(`Expo web export is missing: ${distDir}. Run 'bun run build:web' from client/.`);
}

Bun.serve({
  port,
  fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = path.resolve(distDir, relativePath);
    const filePath = candidate.startsWith(`${distDir}${path.sep}`) ? candidate : path.join(distDir, 'index.html');
    const file = Bun.file(filePath);

    if (file.size > 0) {
      return new Response(file, { headers: { 'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' } });
    }

    return new Response(Bun.file(path.join(distDir, 'index.html')), {
      headers: { 'content-type': mimeTypes['.html'] },
    });
  },
});

console.log(`Expo web export serving on http://127.0.0.1:${port}`);
