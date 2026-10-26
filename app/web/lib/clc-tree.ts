// Pure CLC (中图法) tree logic for the shelf sidebar (no DOM access, unit-tested in tests/mvp-clc-tree.test.mjs).
// Ancestry always comes from `parent` links, never from code prefixes (K82 is not under K81's prefix chain).

export interface ClcNode {
  code: string;
  name: string;
  parent: string | null;
  count?: number;
}

/** Selection value for books without a classification. */
export const UNCLASSIFIED = "none";

/** Non-book material types (docType); `book` and null/unclassified stay in the CLC tree. */
export const DOC_TYPES = ["course", "paper", "articles", "manual", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_LABELS: Record<string, string> = {
  book: "图书",
  course: "课程资料",
  paper: "论文与报告",
  articles: "文章汇编",
  manual: "手册与文档",
  other: "其他资料",
};

/** True for books and not-yet-typed items. */
export const isBookType = (docType: string | null | undefined) => !docType || docType === "book";

export interface ClcIndex {
  byCode: Map<string, ClcNode>;
  /** Children in input order. */
  children: Map<string | null, string[]>;
  /** code -> codes root..code (cached). */
  paths: Map<string, string[]>;
}

export function buildIndex(nodes: ClcNode[]): ClcIndex {
  const byCode = new Map<string, ClcNode>();
  for (const n of nodes) if (n && typeof n.code === "string" && !byCode.has(n.code)) byCode.set(n.code, n);
  const children = new Map<string | null, string[]>();
  for (const n of byCode.values()) {
    // A parent missing from the list (should not happen) makes the node a root.
    const parent = n.parent && byCode.has(n.parent) && n.parent !== n.code ? n.parent : null;
    const list = children.get(parent);
    if (list) list.push(n.code);
    else children.set(parent, [n.code]);
  }
  return { byCode, children, paths: new Map() };
}

/** Codes from root to `code` (inclusive) following parent links; [] when unknown. */
export function pathOf(idx: ClcIndex, code: string | null | undefined): string[] {
  if (!code || !idx.byCode.has(code)) return [];
  const hit = idx.paths.get(code);
  if (hit) return hit;
  const out: string[] = [];
  const seen = new Set<string>();
  for (let c: string | null = code; c && idx.byCode.has(c) && !seen.has(c); c = idx.byCode.get(c)!.parent) {
    seen.add(c);
    out.push(c);
  }
  out.reverse();
  idx.paths.set(code, out);
  return out;
}

/** True when `code` is `ancestor` itself or lies below it. */
export function isWithin(idx: ClcIndex, code: string | null | undefined, ancestor: string): boolean {
  return pathOf(idx, code).includes(ancestor);
}

/** Does a book with classification `clc` match the selection ("" = all, UNCLASSIFIED, or a node code)? */
export function matchesSelection(idx: ClcIndex, clc: string | null | undefined, selected: string): boolean {
  if (!selected) return true;
  if (selected === UNCLASSIFIED) return !clc;
  return isWithin(idx, clc, selected);
}

export interface Counts {
  /** Per node, including descendants. */
  nodes: Map<string, number>;
  unclassified: number;
  total: number;
}

/** Counts over `books`; a clc missing from the index is skipped (counted in total only). */
export function countBooks(idx: ClcIndex, books: { clc?: string | null; docType?: string | null }[]): Counts {
  const nodes = new Map<string, number>();
  let unclassified = 0;
  for (const b of books) {
    if (!isBookType(b.docType)) continue; // non-book material lives in its own sidebar section
    if (!b.clc) {
      unclassified++;
      continue;
    }
    for (const c of pathOf(idx, b.clc)) nodes.set(c, (nodes.get(c) || 0) + 1);
  }
  return { nodes, unclassified, total: books.length };
}

/** Server-provided counts (used before the book list has loaded). */
export function serverCounts(nodes: ClcNode[], unclassified: number, total: number): Counts {
  return { nodes: new Map(nodes.map((n) => [n.code, n.count || 0])), unclassified, total };
}

/** Does a book match the sidebar selection: a non-book type (`type`), or a CLC selection (books only)? */
export function matchesView(
  idx: ClcIndex,
  b: { clc?: string | null; docType?: string | null },
  selected: string,
  type: string,
): boolean {
  if (type) return b.docType === type;
  if (!selected) return true;
  return isBookType(b.docType) && matchesSelection(idx, b.clc, selected);
}

/** Per non-book type counts (book/null types are not counted). */
export function typeCounts(books: { docType?: string | null }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of books) if (!isBookType(b.docType) && b.docType) m.set(b.docType, (m.get(b.docType) || 0) + 1);
  return m;
}

/** `type=` URL parameter: only non-book types are valid. */
export function parseType(p: URLSearchParams): string {
  const v = (p.get("type") || "").trim().toLowerCase();
  return (DOC_TYPES as readonly string[]).includes(v) ? v : "";
}

export function serializeType(type: string, p: URLSearchParams): URLSearchParams {
  p.delete("type");
  if (type) p.set("type", type);
  return p;
}

export interface Row {
  /** Deepest code of the (possibly merged) chain; used as the selection value. */
  code: string;
  /** Merged chain, shallow to deep. */
  chain: ClcNode[];
  depth: number;
  count: number;
  hasChildren: boolean;
  expanded: boolean;
  /** The selection is this row's node or lies within the merged chain. */
  active: boolean;
}

interface Disp {
  chain: ClcNode[];
  count: number;
  kids: Disp[];
}

/**
 * Display tree: nodes with no books are dropped (unless selected / an ancestor of the selection) and a node with
 * exactly one child and no books of its own is merged into that child.
 */
export function buildDisplay(idx: ClcIndex, counts: Counts, selected = ""): Disp[] {
  const keep = new Set(selected && selected !== UNCLASSIFIED ? pathOf(idx, selected) : []);
  const cnt = (c: string) => counts.nodes.get(c) || 0;
  const make = (code: string): Disp | null => {
    const kids = (idx.children.get(code) || []).map(make).filter((d): d is Disp => !!d);
    const count = cnt(code);
    if (!count && !keep.has(code)) return null;
    let node: Disp = { chain: [idx.byCode.get(code)!], count, kids };
    // Merge down while there is a single child and nothing is assigned directly to this node.
    while (node.kids.length === 1 && node.count - node.kids[0].count === 0) {
      const only = node.kids[0];
      node = { chain: [...node.chain, ...only.chain], count: only.count, kids: only.kids };
    }
    return node;
  };
  return (idx.children.get(null) || []).map(make).filter((d): d is Disp => !!d);
}

/**
 * Visible rows. `toggled` holds explicit user choices keyed by row code; otherwise top-level rows and the
 * selection's ancestors are expanded. `all` forces everything open (mobile select).
 */
export function buildRows(
  idx: ClcIndex,
  counts: Counts,
  selected = "",
  toggled: ReadonlyMap<string, boolean> = new Map(),
  all = false,
): Row[] {
  const rows: Row[] = [];
  const selPath = selected && selected !== UNCLASSIFIED ? pathOf(idx, selected) : [];
  const walk = (list: Disp[], depth: number) => {
    for (const d of list) {
      const code = d.chain[d.chain.length - 1].code;
      const deepIdx = selPath.indexOf(code);
      // The selection lies strictly below this row's deepest node.
      const below = deepIdx >= 0 && deepIdx < selPath.length - 1;
      const expanded = all || (toggled.get(code) ?? (depth === 0 || below));
      rows.push({
        code,
        chain: d.chain,
        depth,
        count: d.count,
        hasChildren: d.kids.length > 0,
        expanded: d.kids.length > 0 && expanded,
        active: !!selected && d.chain.some((n) => n.code === selected),
      });
      if (d.kids.length && expanded) walk(d.kids, depth + 1);
    }
  };
  walk(buildDisplay(idx, counts, selected), 0);
  return rows;
}

/** Full chain label for tooltips, e.g. "工业技术 › 自动化技术、计算机技术". */
export const chainLabel = (chain: { name: string }[]) => chain.map((n) => n.name).join(" › ");

/** Name of the deepest node for a book's code, or "未分类". */
export function deepestName(idx: ClcIndex, clc: string | null | undefined): string {
  return (clc && idx.byCode.get(clc)?.name) || "未分类";
}

/** Reads the shelf URL: `clc` selects a node; an unknown code is ignored once the index is known. */
export function parseSelection(p: URLSearchParams): string {
  const v = (p.get("clc") || "").trim();
  return v === UNCLASSIFIED ? v : v.toUpperCase();
}

export function serializeSelection(selected: string, p: URLSearchParams): URLSearchParams {
  p.delete("clc");
  if (selected) p.set("clc", selected);
  return p;
}

/** Picker search over the full table: code (exact, prefix, contains) first, then name matches; table order within a rank. */
export function searchNodes(idx: ClcIndex, query: string, limit = 50): ClcNode[] {
  const q = query.trim();
  if (!q) return [];
  const code = q.toUpperCase();
  const ranked: [number, ClcNode][] = [];
  for (const n of idx.byCode.values()) {
    const c = n.code.toUpperCase();
    const rank = c === code ? 0 : c.startsWith(code) ? 1 : c.includes(code) ? 2 : n.name.includes(q) ? 3 : -1;
    if (rank >= 0) ranked.push([rank, n]);
  }
  return ranked.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, n]) => n);
}

/** Names root..code, e.g. for "工业技术 › 自动化技术、计算机技术". */
export const pathNames = (idx: ClcIndex, code: string) => pathOf(idx, code).map((c) => idx.byCode.get(c)!.name);
