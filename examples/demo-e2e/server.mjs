import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A zero-dependency static server for the demo app.
 *
 * Playwright's `webServer` starts this, so the suite is hermetic: no network,
 * no shared staging environment, and therefore no failures that are really just
 * someone else's deploy. The only failures this suite produces are the ones it
 * is designed to produce.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), 'app');
const port = Number(process.env.PORT ?? 4310);

createServer(async (request, response) => {
  const path = request.url === '/' ? '/index.html' : (request.url ?? '/index.html');
  try {
    const body = await readFile(join(root, path.split('?')[0]));
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, () => {
  console.log(`demo app on http://localhost:${port}`);
});
