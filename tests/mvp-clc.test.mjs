import assert from "node:assert/strict";
import test from "node:test";
import { validateClc, loadClc, indexClc, resolveClc, clcPath, countByTopClass } from "../scripts/clc-check.mjs";

const table = loadClc();
const index = indexClc(table);

test("app/clc.json satisfies the §10 contract", () => {
  assert.deepEqual(validateClc(table), []);
  assert.ok(table.nodes.length >= 300 && table.nodes.length <= 700, `size ${table.nodes.length}`);
});

test("all 22 top-level classes are present", () => {
  const roots = table.nodes.filter((n) => n.parent === null).map((n) => n.code).join("");
  assert.equal(roots, "ABCDEFGHIJKNOPQRSTUVXZ");
  assert.equal(Object.keys(countByTopClass(table)).length, 22);
});

test("key library subtrees exist with expected names", () => {
  assert.equal(index.get("TP311.13").name, "数据库理论与系统");
  assert.equal(index.get("TP312PY").parent, "TP312");
  assert.equal(index.get("TP181").name, "自动推理、机器学习");
  assert.deepEqual(clcPath("TP311.138SQ", index).map((n) => n.code), ["T", "TP", "TP3", "TP31", "TP311", "TP311.1", "TP311.13", "TP311.138", "TP311.138SQ"]);
});

test("resolveClc truncates to the longest in-table prefix", () => {
  assert.equal(resolveClc("TP311.13", index), "TP311.13");
  assert.equal(resolveClc("TP311.138MY", index), "TP311.138");
  assert.equal(resolveClc("TP3-05", index), "TP3");
  assert.equal(resolveClc("I247.558", index), "I247.55");
  assert.equal(resolveClc("tp312ja", index), "TP312JA");
  assert.equal(resolveClc("W123", index), null);
});

test("validator rejects contract violations", () => {
  const bad = { edition: "x", nodes: [
    { code: "T", name: "工业技术", parent: null },
    { code: "TP3", name: "计算技术", parent: "TP" },
    { code: "T", name: "dup", parent: null },
    { code: "tp", name: "", parent: "T" },
    { code: "TQ", name: "化学工业", parent: "T", extra: 1 },
  ] };
  const errors = validateClc(bad);
  assert.ok(errors.some((e) => e.includes("TP3") && e.includes("earlier")));
  assert.ok(errors.some((e) => e.includes("duplicate")));
  assert.ok(errors.some((e) => e.includes("bad code")));
  assert.ok(errors.some((e) => e.includes("empty name")));
  assert.ok(errors.some((e) => e.includes("keys")));
});
