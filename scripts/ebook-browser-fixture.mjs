// Synthetic books only; no API, credentials, repository data, or private files.
import http from "node:http";
import fs from "node:fs/promises";
const root = new URL("../", import.meta.url),
  routes = new Map([
    [
      "/src/lib/reader-formats.mjs",
      ["src/lib/reader-formats.mjs", "text/javascript; charset=utf-8"],
    ],
    ["/", ["tests/fixtures/ebook-reader.html", "text/html; charset=utf-8"]],
    ...[
      "reader.mjs",
      "archive.mjs",
      "sanitize.mjs",
      "parse-worker.mjs",
      "vendor/mobi.js",
    ].map((name) => [
      "/src/lib/ebook/" + name,
      ["src/lib/ebook/" + name, "text/javascript; charset=utf-8"],
    ]),
    [
      "/tests/fixtures/ebook/synthetic.mjs",
      ["tests/fixtures/ebook/synthetic.mjs", "text/javascript; charset=utf-8"],
    ],
  ]);
const server = http.createServer(async (req, res) => {
  const target = routes.get(req.url);
  if (req.method !== "GET" || !target) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": target[1],
    "Cache-Control": "no-store",
  });
  res.end(await fs.readFile(new URL(target[0], root)));
});
server.listen(4401, "127.0.0.1", () =>
  console.log(
    'Synthetic reader fixture: http://127.0.0.1:4401/ — wait for body[data-result="pass"].',
  ),
);
