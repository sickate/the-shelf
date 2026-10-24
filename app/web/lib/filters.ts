// Pure list-filter logic for the shelf page (no DOM access, unit-tested in tests/mvp-filters.test.mjs).
import { READABLE } from "./common";

export const FORMAT_GROUPS = ["pdf", "epub", "mobi", "txt", "other"] as const;
export const FORMAT_LABELS: Record<string, string> = { pdf: "PDF", epub: "EPUB", mobi: "MOBI", txt: "TXT", other: "其他" };
export const SIZE_BUCKETS = ["lt1", "1-5", "5-20", "gt20"] as const;
export const SIZE_LABELS: Record<string, string> = { lt1: "< 1 MB", "1-5": "1–5 MB", "5-20": "5–20 MB", gt20: "> 20 MB" };
export const ADDED_VALUES = ["7", "30"] as const;
export const ADDED_LABELS: Record<string, string> = { "7": "最近 7 天", "30": "最近 30 天" };
export const SORTS = ["title", "recent", "size", "format"] as const;
export type SortKey = (typeof SORTS)[number];
export type Tri = "" | "1" | "0";
export type Facet = "fmt" | "size" | "added" | "author";

export interface FilterState {
  fmt: string[];
  size: string[];
  added: "" | "7" | "30";
  readable: boolean;
  cover: Tri;
  info: Tri;
  author: string;
}

export interface FilterEntry {
  title: string;
  format: string;
  sizeBytes: number;
  status: string;
  _created: number;
  hasCover?: boolean;
  hasInfo?: boolean;
  authors?: string[];
}

export interface FilterOpts {
  /** Owner-only filters (cover/info/author) are ignored unless true. */
  owner: boolean;
  now: number;
}

const DAY = 86_400_000;
const MB = 1_000_000;

export const emptyFilters = (): FilterState => ({ fmt: [], size: [], added: "", readable: false, cover: "", info: "", author: "" });

const cleanFormat = (format: string) => String(format || "").toLowerCase().replace(/^\./, "");

export function formatGroup(format: string): string {
  const f = cleanFormat(format);
  if (f === "pdf" || f === "epub") return f;
  if (f === "mobi" || f === "azw3" || f === "azw") return "mobi";
  if (f === "txt" || f === "md") return "txt";
  return "other";
}

export function sizeBucket(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < MB) return "lt1";
  if (n < 5 * MB) return "1-5";
  if (n <= 20 * MB) return "5-20";
  return "gt20";
}

export const isReadable = (b: Pick<FilterEntry, "format" | "status">) => b.status === "uploaded" && READABLE.has(cleanFormat(b.format));

const pick = (raw: string | null, allowed: readonly string[]) =>
  (raw || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => allowed.includes(s));

/** Canonical order keeps serialisation stable. */
const ordered = (vals: string[], allowed: readonly string[]) => allowed.filter((v) => vals.includes(v));

export function parseFilters(p: URLSearchParams): FilterState {
  const added = p.get("added");
  const tri = (k: string): Tri => (p.get(k) === "1" ? "1" : p.get(k) === "0" ? "0" : "");
  return {
    fmt: ordered(pick(p.get("fmt"), FORMAT_GROUPS), FORMAT_GROUPS),
    size: ordered(pick(p.get("size"), SIZE_BUCKETS), SIZE_BUCKETS),
    added: added === "7" || added === "30" ? added : "",
    readable: p.get("readable") === "1",
    cover: tri("cover"),
    info: tri("info"),
    author: (p.get("author") || "").trim(),
  };
}

/** Writes only active filters into `p` (and removes inactive keys). */
export function serializeFilters(s: FilterState, p: URLSearchParams): URLSearchParams {
  for (const k of ["fmt", "size", "added", "readable", "cover", "info", "author"]) p.delete(k);
  if (s.fmt.length) p.set("fmt", s.fmt.join(","));
  if (s.size.length) p.set("size", s.size.join(","));
  if (s.added) p.set("added", s.added);
  if (s.readable) p.set("readable", "1");
  if (s.cover) p.set("cover", s.cover);
  if (s.info) p.set("info", s.info);
  if (s.author) p.set("author", s.author);
  return p;
}

export function parseSort(v: string | null): SortKey {
  return (SORTS as readonly string[]).includes(v || "") ? (v as SortKey) : "title";
}

/** Drops owner-only filters for visitors. */
export function effective(s: FilterState, owner: boolean): FilterState {
  return owner ? s : { ...s, cover: "", info: "", author: "" };
}

export function hasActive(s: FilterState, owner = true): boolean {
  const e = effective(s, owner);
  return !!(e.fmt.length || e.size.length || e.added || e.readable || e.cover || e.info || e.author);
}

/** Build a predicate; `skip` leaves one facet out (for faceted counts). */
export function buildPredicate(s: FilterState, opts: FilterOpts, skip?: Facet): (b: FilterEntry) => boolean {
  const e = effective(s, opts.owner);
  const checks: ((b: FilterEntry) => boolean)[] = [];
  if (e.fmt.length && skip !== "fmt") checks.push((b) => e.fmt.includes(formatGroup(b.format)));
  if (e.size.length && skip !== "size") checks.push((b) => e.size.includes(sizeBucket(b.sizeBytes)));
  if (e.added && skip !== "added") {
    const since = opts.now - Number(e.added) * DAY;
    checks.push((b) => b._created >= since);
  }
  if (e.readable) checks.push(isReadable);
  if (e.cover) checks.push((b) => !!b.hasCover === (e.cover === "1"));
  if (e.info) checks.push((b) => !!b.hasInfo === (e.info === "1"));
  if (e.author && skip !== "author") checks.push((b) => !!b.authors?.includes(e.author));
  return (b) => checks.every((c) => c(b));
}

export function filterEntries<T extends FilterEntry>(list: T[], s: FilterState, opts: FilterOpts): T[] {
  return hasActive(s, opts.owner) ? list.filter(buildPredicate(s, opts)) : list;
}

/** Counts per facet value over `list` (already narrowed by search/status/category), ignoring that facet's own filter. */
export function facetCounts(list: FilterEntry[], s: FilterState, opts: FilterOpts, facet: Facet): Map<string, number> {
  const pass = buildPredicate(s, opts, facet);
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) || 0) + 1);
  for (const b of list) {
    if (!pass(b)) continue;
    if (facet === "fmt") bump(formatGroup(b.format));
    else if (facet === "size") bump(sizeBucket(b.sizeBytes));
    else if (facet === "added") {
      if (b._created >= opts.now - 30 * DAY) bump("30");
      if (b._created >= opts.now - 7 * DAY) bump("7");
    } else for (const a of new Set(b.authors || [])) bump(a);
  }
  return counts;
}

export function sortEntries<T extends FilterEntry>(list: T[], key: SortKey, collator: Intl.Collator): T[] {
  const byTitle = (a: T, b: T) => collator.compare(a.title, b.title);
  const rank = (b: T) => FORMAT_GROUPS.indexOf(formatGroup(b.format) as (typeof FORMAT_GROUPS)[number]);
  const cmp: Record<SortKey, (a: T, b: T) => number> = {
    title: byTitle,
    recent: (a, b) => b._created - a._created || byTitle(a, b),
    size: (a, b) => (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0) || byTitle(a, b),
    format: (a, b) => rank(a) - rank(b) || byTitle(a, b),
  };
  return list.slice().sort(cmp[key]);
}

/** e.g. "PDF、EPUB · 5–20 MB · 18 本" */
export function summarize(s: FilterState, owner: boolean, count: number): string {
  const e = effective(s, owner);
  const parts: string[] = [];
  if (e.fmt.length) parts.push(e.fmt.map((f) => FORMAT_LABELS[f]).join("、"));
  if (e.size.length) parts.push(e.size.map((k) => SIZE_LABELS[k]).join("、"));
  if (e.added) parts.push(ADDED_LABELS[e.added]);
  if (e.readable) parts.push("可在线阅读");
  if (e.cover) parts.push(e.cover === "1" ? "有缩略图" : "无缩略图");
  if (e.info) parts.push(e.info === "1" ? "有 AI 简介" : "无 AI 简介");
  if (e.author) parts.push(`作者：${e.author}`);
  parts.push(`${count.toLocaleString()} 本`);
  return parts.join(" · ");
}
