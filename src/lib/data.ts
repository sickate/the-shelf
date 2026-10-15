import fs from "node:fs";
import { fileStatus } from "./file-availability.mjs";
export interface BookFile {
  id: string;
  format: string;
  sizeBytes: number;
  status: string;
  reason: string;
  visibility: string;
  readable: boolean;
}
export interface Book {
  id: string;
  title: string;
  author: string | null;
  category: string;
  categoryId: string;
  tags: string[];
  description: string;
  files: BookFile[];
}
export interface Doc {
  id: string;
  title: string;
  description: string;
  updatedAt: string;
  version: string;
  markdown: string;
  htmlPath: string;
  rawPath: string;
}
function read(name: string, fallback: any) {
  try {
    return JSON.parse(
      fs.readFileSync(`${process.cwd()}/data/${name}.json`, "utf8"),
    );
  } catch {
    return fallback;
  }
}
export const catalog = read("catalog", {
  books: [],
  categories: [],
  stats: { books: 0, files: 0, totalBytes: 0 },
  sourceStatus: "unavailable",
}) as {
  books: Book[];
  categories: { id: string; name: string; count: number }[];
  stats: any;
  sourceStatus: string;
};
export const documents = (read("docs", { documents: [] }).documents ||
  []) as Doc[];
export const base = import.meta.env.BASE_URL;
export const path = (s = "") => `${base}${s.replace(/^\//, "")}`;
export const size = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${(n / 1e3).toFixed(0)} KB`;
export const status = (f: BookFile) => fileStatus(f);
export const color = (id: string) =>
  ["#9d4230", "#365749", "#4e5574", "#976a37", "#62544a", "#7b4657"][
    Array.from(id).reduce((a, c) => a + c.charCodeAt(0), 0) % 6
  ];
