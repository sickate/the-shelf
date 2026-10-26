#!/usr/bin/env node
// Validates app/clc.json against the C1/C2 contract
// (docs/classification-plan-2026-10-24.md §10). No dependencies.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CLC_CODE_RE = /^[A-Z][A-Z0-9.\-]*$/;

/** Returns a list of human-readable problems; empty when the table is valid. */
export function validateClc(table) {
  const errors = [];
  if (!table || typeof table !== "object" || !Array.isArray(table.nodes)) {
    return ["table must be an object with a nodes array"];
  }
  if (typeof table.edition !== "string" || !table.edition.trim()) errors.push("edition must be a non-empty string");
  const seen = new Map();
  table.nodes.forEach((node, i) => {
    const where = `nodes[${i}]`;
    if (!node || typeof node !== "object") return errors.push(`${where}: not an object`);
    const keys = Object.keys(node).sort().join(",");
    if (keys !== "code,name,parent") errors.push(`${where}: keys must be exactly code,name,parent (got ${keys})`);
    const { code, name, parent } = node;
    if (typeof code !== "string" || !CLC_CODE_RE.test(code) || /[.\-]$/.test(code) || /[.\-]{2}/.test(code)) {
      errors.push(`${where}: bad code ${JSON.stringify(code)}`);
    }
    if (typeof name !== "string" || !name.trim()) errors.push(`${where} ${code}: empty name`);
    if (seen.has(code)) errors.push(`${where}: duplicate code ${code}`);
    if (parent === null) {
      if (typeof code === "string" && code.length !== 1) errors.push(`${where} ${code}: only single-letter classes may be roots`);
    } else if (typeof parent !== "string" || !seen.has(parent)) {
      errors.push(`${where} ${code}: parent ${JSON.stringify(parent)} must be an earlier node`);
    } else if (parent === code) {
      errors.push(`${where} ${code}: parent is itself`);
    } else if (typeof code === "string" && parent[0] !== code[0]) {
      // Parents need not be strict prefixes (e.g. K82 中国人物传记 sits under K81 传记),
      // but must stay inside the same top-level class.
      errors.push(`${where} ${code}: parent ${parent} is in another top-level class`);
    }
    seen.set(code, node);
  });
  // Parents precede children, so a cycle is impossible once the above holds;
  // still walk each chain defensively.
  for (const node of table.nodes) {
    const path = new Set();
    let cur = node;
    while (cur && cur.parent !== null) {
      if (path.has(cur.code)) { errors.push(`${node.code}: cycle`); break; }
      path.add(cur.code);
      cur = seen.get(cur.parent);
    }
  }
  return errors;
}

/** Map code -> node. */
export function indexClc(table) {
  return new Map(table.nodes.map((n) => [n.code, n]));
}

/** Longest in-table prefix of `code` (strip characters from the end, incl. '.' and '-'); null if none. */
export function resolveClc(code, index) {
  let c = String(code || "").trim().toUpperCase();
  while (c) {
    if (index.has(c)) return c;
    c = c.slice(0, -1);
  }
  return null;
}

/** Root-to-node list of nodes for an in-table code. */
export function clcPath(code, index) {
  const out = [];
  let cur = index.get(code);
  while (cur) { out.unshift(cur); cur = cur.parent === null ? null : index.get(cur.parent); }
  return out;
}

export function countByTopClass(table) {
  const counts = {};
  for (const n of table.nodes) counts[n.code[0]] = (counts[n.code[0]] || 0) + 1;
  return counts;
}

export function loadClc(path = fileURLToPath(new URL("../app/clc.json", import.meta.url))) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const table = loadClc(process.argv[2]);
  const errors = validateClc(table);
  const counts = countByTopClass(table);
  for (const [k, v] of Object.entries(counts)) console.log(`${k}\t${v}`);
  console.log(`total\t${table.nodes.length}`);
  if (errors.length) {
    for (const e of errors) console.error("ERROR " + e);
    process.exit(1);
  }
  console.log("clc.json OK");
}
