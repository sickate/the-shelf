import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_SITE = "https://the-shelf.iamzhutuo.workers.dev";

function fail(message) {
  throw new Error(message);
}

function plainOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`expected an HTTPS origin, got ${raw}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    fail(`expected a plain HTTPS origin, got ${raw}`);
  return url.origin;
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function references(html) {
  const found = [];
  const attr = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(attr)) found.push(decodeHtml(match[1] ?? match[2] ?? match[3]));
  const srcset = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of html.matchAll(srcset)) {
    for (const candidate of (match[1] ?? match[2]).split(","))
      found.push(candidate.trim().split(/\s+/)[0]);
  }
  return found;
}

async function walk(directory, relative = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const rel = path.posix.join(relative, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`static output contains symlink: ${rel}`);
    if (entry.isDirectory()) result.push(...(await walk(absolute, rel)));
    else if (entry.isFile()) result.push({ relative: rel, absolute, size: (await stat(absolute)).size });
  }
  return result;
}

function pathForReference(reference, currentFile, siteOrigin, basePath) {
  if (!reference || /^(?:#|mailto:|tel:|data:|javascript:|blob:)/i.test(reference)) return null;
  let url;
  try {
    const routePath = `${basePath}${currentFile.replace(/index\.html$/, "")}`;
    url = new URL(reference, new URL(routePath, siteOrigin));
  } catch {
    fail(`invalid HTML URL reference ${reference} in ${currentFile}`);
  }
  if (url.origin !== siteOrigin) return null;
  if (!url.pathname.startsWith(basePath)) fail(`internal URL escapes site base ${basePath}: ${url.pathname} in ${currentFile}`);
  let relative = decodeURIComponent(url.pathname.slice(basePath.length));
  relative = relative.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  return path.posix.normalize(relative);
}

function expectedBasePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || !value.endsWith("/")) fail("docs index has invalid basePath");
  return value;
}

export async function verifyLocal({ dist = path.join(ROOT, "dist"), catalogFile = path.join(ROOT, "data/catalog.json"), expectedOrigin = null } = {}) {
  const files = await walk(dist);
  if (files.length > MAX_FILES) fail(`static file count ${files.length} exceeds free-tier limit ${MAX_FILES}`);
  for (const file of files) if (file.size > MAX_FILE_BYTES) fail(`static file exceeds 25 MiB: ${file.relative}`);
  const fileByName = new Map(files.map((file) => [file.relative, file]));
  const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
  if (!Array.isArray(catalog.books)) fail("catalog has no books array");
  const docIndexFile = fileByName.get("docs/index.json");
  if (!docIndexFile) fail("missing docs/index.json");
  const index = JSON.parse(await readFile(docIndexFile.absolute, "utf8"));
  const basePath = expectedBasePath(index.basePath);
  const inferredOrigin = index.documents?.[0]?.htmlUrl ? new URL(index.documents[0].htmlUrl).origin : DEFAULT_SITE;
  const origin = plainOrigin(expectedOrigin || process.env.SHELF_CF_SITE_URL || inferredOrigin);
  const mapped = (urlPath, label) => {
    if (typeof urlPath !== "string" || !urlPath.startsWith(basePath)) fail(`${label} does not use docs index basePath ${basePath}`);
    const name = decodeURIComponent(urlPath.slice(basePath.length)).replace(/^\/+/, "");
    const normalized = path.posix.normalize(name.endsWith("/") || !name ? `${name}index.html` : name);
    if (!fileByName.has(normalized)) fail(`${label} points to missing static file: ${urlPath}`);
    return normalized;
  };

  const docIds = new Set();
  for (const doc of index.documents ?? []) {
    if (docIds.has(doc.id)) fail(`duplicate document id ${doc.id}`);
    docIds.add(doc.id);
    const htmlPath = mapped(doc.htmlPath, `document ${doc.id} HTML path`);
    const rawPath = mapped(doc.rawPath, `document ${doc.id} raw path`);
    const expectedHtmlUrl = new URL(doc.htmlPath, origin).href;
    const expectedRawUrl = new URL(doc.rawPath, origin).href;
    if (doc.htmlUrl !== expectedHtmlUrl || doc.rawUrl !== expectedRawUrl)
      fail(`document ${doc.id} URLs disagree with basePath/origin`);
    const raw = await readFile(fileByName.get(rawPath).absolute);
    const version = createHash("sha256").update(raw).digest("hex");
    if (doc.version !== version) fail(`document ${doc.id} version does not match raw Markdown`);
    if (!htmlPath.startsWith("docs/")) fail(`document ${doc.id} HTML page is outside docs`);
  }
  if (!docIds.size) fail("docs index contains no documents");
  if (index.basePath !== basePath) fail("docs index basePath is malformed");

  for (const book of catalog.books) {
    const expected = `books/${book.id}/index.html`;
    if (!fileByName.has(expected)) fail(`book ${book.id} has no static detail page`);
  }

  const readerHtml = fileByName.get("read/index.html");
  if (!readerHtml) fail("missing static reader page");
  const html = await readFile(readerHtml.absolute, "utf8");
  const readerRefs = references(html).map((ref) => pathForReference(ref, "read/index.html", origin, basePath)).filter(Boolean);
  const localReaderScripts = readerRefs.filter((ref) => /\.(?:m?js)$/.test(ref));
  if (!localReaderScripts.length) fail("reader page does not reference a local JavaScript asset");
  const jsContents = new Map();
  const pendingScripts = [...localReaderScripts];
  while (pendingScripts.length) {
    const ref = pendingScripts.pop();
    if (jsContents.has(ref)) continue;
    const file = fileByName.get(ref);
    if (!file) fail(`reader script or imported chunk is missing: ${ref}`);
    const contents = await readFile(file.absolute, "utf8");
    jsContents.set(ref, contents);
    for (const match of contents.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["'`](\.\.?\/[^"'`]+\.(?:m?js))(?:\?[^"'`]*)?["'`]/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(ref), match[1]));
      if (!jsContents.has(dependency)) pendingScripts.push(dependency);
    }
  }
  const joinedJs = [...jsContents.values()].join("\n");
  if (!/epub/i.test(joinedJs)) fail("EPUB reader implementation is absent from static JavaScript assets");
  if (!/pdfjs|pdf\.worker|GlobalWorkerOptions|PDFDocumentProxy/i.test(joinedJs)) fail("PDF.js reader implementation is absent from static JavaScript assets");
  const pdfWorkerShim = [...jsContents.entries()].find(([name]) => /pdf\.worker/i.test(name));
  const workerUrls = [...(pdfWorkerShim?.[1] || "").matchAll(/["'`](\/[^"'`]+\.mjs)["'`]/g)].map((match) => match[1]);
  if (!workerUrls.length) fail("PDF.js worker module is not referenced by the reader bundle");
  for (const workerUrl of workerUrls) {
    if (!workerUrl.startsWith(basePath)) fail(`PDF.js worker URL is outside site base ${basePath}: ${workerUrl}`);
    const workerPath = decodeURIComponent(workerUrl.slice(basePath.length)).replace(/^\/+/, "");
    if (!fileByName.has(workerPath)) fail(`PDF.js worker module is missing: ${workerUrl}`);
  }

  const missing = new Set();
  for (const file of files.filter((f) => f.relative.endsWith(".html"))) {
    const content = await readFile(file.absolute, "utf8");
    for (const ref of references(content)) {
      const resolved = pathForReference(ref, file.relative, origin, basePath);
      if (resolved && !fileByName.has(resolved)) missing.add(`${file.relative}: ${ref} -> ${resolved}`);
    }
  }
  if (missing.size) fail(`broken internal links:\n${[...missing].slice(0, 30).join("\n")}`);

  return { dist, files: files.length, html: files.filter((f) => f.relative.endsWith(".html")).length, books: catalog.books.length, documents: index.documents.length, bytes: files.reduce((sum, file) => sum + file.size, 0), basePath, origin, filesList: files.map((f) => f.relative) };
}

async function request(url, method, attempts = 1) {
  let lastError;
  let lastResponse;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, { method, redirect: "follow", signal: controller.signal });
      clearTimeout(timeout);
      lastResponse = response;
      if (attempt + 1 < attempts && (response.status === 408 || response.status === 429 || response.status >= 500)) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError;
}

async function pool(items, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

export async function verifyRemote(local, rawOrigin) {
  const origin = plainOrigin(rawOrigin);
  const basePath = local.basePath;
  const urlFor = (relative) => new URL(basePath + relative.replace(/^\/+/, ""), origin).href;
  const targetFiles = local.filesList.filter((file) => file.endsWith(".html") || /\.(?:css|js|mjs|json|svg|woff2?|ttf|otf|wasm|png|jpe?g|webp|ico|xml|txt|md)$/i.test(file));
  await pool(targetFiles, 6, async (file) => {
    const response = await request(urlFor(file), "HEAD", 3);
    if (!response.ok) fail(`remote HEAD ${response.status} for ${urlFor(file)}`);
  });

  const home = await request(urlFor("index.html"), "GET", 3);
  const homeBody = await home.text();
  if (!home.ok || !homeBody.includes("The Shelf")) fail("remote home GET did not return expected bookcase HTML");
  if (!home.headers.get("content-type")?.includes("text/html")) fail("remote home has incorrect content type");
  if (homeBody !== await readFile(path.join(local.dist, "index.html"), "utf8")) fail("remote home differs from the built static artifact");
  const book = local.filesList.find((file) => /^books\/[^/]+\/index\.html$/.test(file));
  if (!book) fail("no book detail page available for remote sample");
  const bookResponse = await request(urlFor(book), "GET", 3);
  const bookBody = await bookResponse.text();
  if (!bookResponse.ok || !bookBody.includes("在线阅读")) fail(`remote book GET failed content check for ${book}`);
  if (!bookResponse.headers.get("content-type")?.includes("text/html")) fail("remote book page has incorrect content type");
  if (bookBody !== await readFile(path.join(local.dist, book), "utf8")) fail(`remote book page differs from the built artifact: ${book}`);
  for (const [sample, contentType] of [["docs/index.json", "application/json"], ["docs/all.md", "text/markdown"], ["docs/raw/overview.md", "text/markdown"]]) {
    const response = await request(urlFor(sample), "GET", 3);
    if (!response.ok) fail(`remote GET ${response.status} for ${sample}`);
    const body = await response.text();
    if (!response.headers.get("content-type")?.includes(contentType)) fail(`remote ${sample} has incorrect content type`);
    const expected = await readFile(path.join(local.dist, sample), "utf8");
    if (body !== expected) fail(`remote ${sample} differs from the built static artifact`);
    if (sample.endsWith("index.json")) {
      const remoteIndex = JSON.parse(body);
      const localIndex = JSON.parse(expected);
      if (remoteIndex.basePath !== basePath || remoteIndex.version !== localIndex.version) fail("remote docs index has incorrect basePath or version");
    } else if (!body.trim()) fail(`remote ${sample} is empty`);
  }
  const missing = await request(urlFor("__shelf_static_verify_missing__/"), "GET", 3);
  const missingBody = await missing.text();
  if (missing.status !== 404) fail(`nonexistent path returned ${missing.status}, expected 404`);
  const homeAgain = await (await request(urlFor("index.html"), "GET", 3)).text();
  if (missingBody === homeAgain) fail("nonexistent path returned the home page instead of a real 404");
  return { origin, checked: targetFiles.length, missingPathStatus: missing.status };
}

async function main(argv) {
  const options = { dist: path.join(ROOT, "dist"), catalogFile: path.join(ROOT, "data/catalog.json"), url: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!["--url", "--dist", "--catalog"].includes(arg)) fail(`unknown option or argument ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
    if (arg === "--url") options.url = value;
    else if (arg === "--dist") options.dist = path.resolve(value);
    else options.catalogFile = path.resolve(value);
  }
  const local = await verifyLocal({ dist: options.dist, catalogFile: options.catalogFile, expectedOrigin: process.env.SHELF_CF_SITE_URL || null });
  const remote = options.url ? await verifyRemote(local, options.url) : null;
  console.log(JSON.stringify({ ok: true, local: { files: local.files, html: local.html, books: local.books, documents: local.documents, bytes: local.bytes, basePath: local.basePath }, remote }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
