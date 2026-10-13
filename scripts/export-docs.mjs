import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// This is intentionally a fixed publication boundary. Operational notes and
// any future file stay private until explicitly reviewed and added here.
export const PUBLIC_DOCS = [
  ["README.md", "overview"],
  ["product.md", "product"],
  ["architecture.md", "architecture"],
  ["import-policy.md", "import-policy"],
  ["inventory.md", "inventory"],
  ["ai.md", "ai"],
  ["public-docs.md", "public-docs"],
  ["implementation-plan.md", "implementation-plan"],
  ["decisions.md", "decisions"],
  ["development-plan.md", "development-plan"],
  ["contracts.md", "contracts"],
  ["runbook.md", "runbook"],
];

function titleOf(markdown, fallback) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
}

function descriptionOf(markdown) {
  const lines = markdown.split(/\r?\n/);
  let start = Math.max(0, lines.findIndex((line) => /^#\s/.test(line)) + 1);
  while (
    start < lines.length &&
    (!lines[start].trim() ||
      /^#+\s/.test(lines[start]) ||
      /^更新日期：/.test(lines[start].trim()))
  )
    start++;
  const paragraph = [];
  while (
    start < lines.length &&
    lines[start].trim() &&
    !/^\s*\|/.test(lines[start]) &&
    !/^更新日期：/.test(lines[start].trim())
  )
    paragraph.push(lines[start++].trim());
  return paragraph.join(" ").replace(/[*_`]/g, "").slice(0, 240);
}

function updatedAt(markdown) {
  const match = markdown.match(
    /^更新日期：\s*(\d{4}) 年 (\d{1,2}) 月 (\d{1,2}) 日/m,
  );
  return match
    ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`
    : null;
}

export async function exportDocs(root = ROOT, options = {}) {
  const docsRoot = path.join(root, "docs");
  const documents = [];
  for (const [filename, id] of PUBLIC_DOCS) {
    const markdown = await readFile(path.join(docsRoot, filename), "utf8");
    const version = createHash("sha256").update(markdown).digest("hex");
    documents.push({
      id,
      title: titleOf(markdown, id),
      description: descriptionOf(markdown),
      updatedAt: updatedAt(markdown),
      version,
      markdown,
      htmlPath: id === "overview" ? "docs" : `docs/${id}`,
      rawPath: `docs/raw/${id}.md`,
    });
  }
  const generatedAt = new Date().toISOString();
  const output = path.join(root, "data");
  const publicDocs = path.join(root, "public", "docs");
  const site =
    options.siteUrl || process.env.SHELF_SITE_URL || "http://localhost:4321";
  const base =
    `/${(options.basePath || process.env.SHELF_BASE_PATH || "/").replace(/^\/+|\/+$/g, "")}`.replace(
      /\/$/,
      "",
    ) + "/";
  const urlFor = (relative) =>
    new URL(base + relative.replace(/^\/+/, ""), site).href;
  const index = {
    generatedAt,
    version: createHash("sha256")
      .update(documents.map((d) => d.version).join(""))
      .digest("hex"),
    basePath: base,
    documents: documents.map(
      ({
        id,
        title,
        description,
        updatedAt: date,
        version,
        htmlPath,
        rawPath,
      }) => ({
        id,
        title,
        description,
        updatedAt: date,
        version,
        htmlPath: base + htmlPath.replace(/\/$/, "") + "/",
        rawPath: base + rawPath,
        htmlUrl: urlFor(htmlPath.replace(/\/$/, "") + "/"),
        rawUrl: urlFor(rawPath),
      }),
    ),
  };
  await mkdir(output, { recursive: true });
  await mkdir(path.join(publicDocs, "raw"), { recursive: true });
  await writeFile(
    path.join(output, "docs.json"),
    JSON.stringify(
      {
        generatedAt,
        version: createHash("sha256")
          .update(documents.map((d) => d.version).join(""))
          .digest("hex"),
        documents,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(publicDocs, "index.json"),
    JSON.stringify(index, null, 2) + "\n",
  );
  await writeFile(
    path.join(publicDocs, "all.md"),
    documents
      .map((d) => `<!-- ${d.id} -->\n\n${d.markdown.trim()}\n`)
      .join("\n---\n\n"),
  );
  for (const document of documents)
    await writeFile(
      path.join(publicDocs, document.rawPath.slice("docs/".length)),
      document.markdown,
    );
  return { count: documents.length, ids: documents.map((d) => d.id) };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await exportDocs();
  console.log(JSON.stringify(result));
}
