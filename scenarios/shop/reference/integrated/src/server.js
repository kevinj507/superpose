// The shop as a web server: node src/server.js serves it over HTTP on the
// port in PORT (3000 by default). createServer() is a node:http server that
// passes each request's method and path to handle() and writes back the
// status, headers and body it returns. Importing this file starts nothing.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { handle } from './app.js';

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const { status, headers, body } = await handle({ method: req.method, path: req.url });
      res.writeHead(status, headers);
      res.end(body);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Something went wrong\n');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`Tiny Shop is open at http://localhost:${port}/`));
}
