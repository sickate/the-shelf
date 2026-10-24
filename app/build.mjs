// Build the MVP frontend: app/web -> app/dist
import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "web");
const dist = join(here, "dist");
const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Static HTML/CSS
const entries = [];
for (const name of await readdir(web)) {
  if (/\.(html|css|ico|svg|png|txt)$/.test(name)) await cp(join(web, name), join(dist, name));
  else if (/\.ts$/.test(name) && !name.endsWith(".d.ts")) entries.push(join(web, name));
}

// Bundle TS entry points (dynamic imports become shared chunks)
await build({
  entryPoints: entries,
  outdir: dist,
  bundle: true,
  format: "esm",
  splitting: true,
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  chunkNames: "chunks/[name]-[hash]",
  legalComments: "none",
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
});

// pdf.js worker + data files, served same-origin under /pdfjs/
const pdfOut = join(dist, "pdfjs");
await mkdir(pdfOut, { recursive: true });
await cp(join(pdfjsRoot, "build", "pdf.worker.min.mjs"), join(pdfOut, "pdf.worker.min.mjs"));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(join(pdfjsRoot, dir), join(pdfOut, dir), { recursive: true }).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
}

const required = ["index.html", "book.html", "read.html", "404.html", "style.css", "shelf.js", "book.js", "read.js", "pdfjs/pdf.worker.min.mjs"];
for (const f of required) {
  await readdir(dirname(join(dist, f))).then((names) => {
    if (!names.includes(f.split("/").pop())) throw new Error(`missing ${f}`);
  });
}
console.log(`built ${dist}`);
