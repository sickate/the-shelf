// Serves only a synthetic DOM test and its production controller. No project state or API.
import http from "node:http";
import fs from "node:fs/promises";
const files = new Map([
  [
    "/account/",
    [
      new URL("../tests/fixtures/account-gate.html", import.meta.url),
      "text/html; charset=utf-8",
    ],
  ],
  [
    "/account-gate.mjs",
    [
      new URL("../src/lib/account-gate.mjs", import.meta.url),
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/",
    [
      new URL("../tests/fixtures/metadata-editor.html", import.meta.url),
      "text/html; charset=utf-8",
    ],
  ],
  [
    "/metadata-editor.mjs",
    [
      new URL("../src/lib/metadata-editor.mjs", import.meta.url),
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/file-actions/",
    [
      new URL("../tests/fixtures/file-actions.html", import.meta.url),
      "text/html; charset=utf-8",
    ],
  ],
  [
    "/file-actions.mjs",
    [
      new URL("../src/lib/file-actions.mjs", import.meta.url),
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/file-availability.mjs",
    [
      new URL("../src/lib/file-availability.mjs", import.meta.url),
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/reader-formats.mjs",
    [
      new URL("../src/lib/reader-formats.mjs", import.meta.url),
      "text/javascript; charset=utf-8",
    ],
  ],
]);
const server = http.createServer(async (req, res) => {
  const target = files.get(req.url);
  if (req.method !== "GET" || !target) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": target[1],
    "Cache-Control": "no-store",
  });
  res.end(await fs.readFile(target[0]));
});
server.listen(4399, "127.0.0.1", () =>
  console.log(
    'Synthetic DOM tests: http://127.0.0.1:4399/ (metadata), http://127.0.0.1:4399/account/ (account) — wait for body[data-result="pass"].',
  ),
);
