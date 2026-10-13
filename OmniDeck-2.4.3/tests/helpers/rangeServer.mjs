// Tiny HTTP server for download tests. Serves an in-memory body (any path) or a
// {path: Buffer} map, supports HTTP Range (206 / 416), a "drop the connection
// after N bytes on the first full request" fault, a servers-that-ignore-Range
// mode and a fixed-status mode.
import { createServer } from "node:http";

export function startRangeServer(bodyOrMap, opts = {}) {
  const state = { requests: [], dropped: false };
  const server = createServer((req, res) => {
    const range = req.headers["range"] || null;
    state.requests.push({ url: req.url, range });
    if (opts.status && opts.status !== 200) { res.writeHead(opts.status); return res.end("nope"); }
    const body = Buffer.isBuffer(bodyOrMap) ? bodyOrMap : bodyOrMap[req.url.split("?")[0]];
    if (!body) { res.writeHead(404); return res.end("not found"); }
    let start = 0;
    let status = 200;
    if (range && !opts.ignoreRange) {
      const m = /^bytes=(\d+)-$/.exec(range);
      if (m) {
        start = Number(m[1]);
        if (start >= body.length) {
          res.writeHead(416, { "Content-Range": `bytes */${body.length}` });
          return res.end();
        }
        status = 206;
      }
    }
    const chunk = body.subarray(start);
    const headers = { "Content-Type": "application/octet-stream", "Content-Length": chunk.length };
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
    res.writeHead(status, headers);
    if (opts.dropAfter && !state.dropped && start === 0 && chunk.length > opts.dropAfter) {
      state.dropped = true;
      res.write(chunk.subarray(0, opts.dropAfter));
      setTimeout(() => res.socket.destroy(), 50);
      return;
    }
    res.end(chunk);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      url: `http://127.0.0.1:${server.address().port}/file.bin`,
      state,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}
