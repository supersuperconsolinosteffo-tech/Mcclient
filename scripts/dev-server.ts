import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { dispatchRpcMethod } from '../server/rpcRouter';
import { VesperaStateCoordinator } from '../server/stateStore';

const PORT = Number(process.env.PORT || 4173);
const ROOT = process.cwd();
const coordinator = new VesperaStateCoordinator();

async function start() {
  const distUiDir = path.join(ROOT, 'dist/ui');
  const useStaticDist = fs.existsSync(path.join(distUiDir, 'index.html')) && process.env.VESPERA_STATIC === '1';

  let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;
  if (!useStaticDist) {
    vite = await createViteServer({
      configFile: path.join(ROOT, 'vite.config.ts'),
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa',
    });
  }

  const mimeMap: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
  };

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (urlObj.pathname === '/api/rpc' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          method?: string;
          params?: Record<string, unknown>;
        };
        if (!body.method) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing RPC method' }));
          return;
        }
        const data = await dispatchRpcMethod(coordinator, body.method, body.params || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data }));
        return;
      }

      if (urlObj.pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'vespera-client', version: '1.2.0' }));
        return;
      }

      if (vite) {
        vite.middlewares(req, res, () => {
          res.writeHead(404);
          res.end('Not found');
        });
        return;
      }

      // Serve compiled dist/ui
      let reqPath = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
      const safeFile = path.resolve(distUiDir, '.' + reqPath);
      if (safeFile.startsWith(distUiDir) && fs.existsSync(safeFile) && fs.statSync(safeFile).isFile()) {
        const ext = path.extname(safeFile).toLowerCase();
        res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
        fs.createReadStream(safeFile).pipe(res);
      } else {
        const indexHtml = path.join(distUiDir, 'index.html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(indexHtml).pipe(res);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
  });

  process.on('SIGTERM', () => {
    coordinator.shutdownCleanly();
    process.exit(0);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Vespera Client Desktop Service listening on http://0.0.0.0:${PORT}`);
  });
}

start();
