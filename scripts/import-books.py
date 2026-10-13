#!/usr/bin/env python3
"""Build a privacy-filtered public catalogue and a private local file manifest."""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import stat
import tempfile
import unicodedata
from pathlib import Path

SUPPORTED = {".pdf": "PDF", ".epub": "EPUB", ".mobi": "MOBI", ".azw": "AZW", ".azw3": "AZW3", ".azw4": "AZW4"}
READABLE = {"PDF", "EPUB"}
SYSTEM_NAMES = {".ds_store", "thumbs.db", "desktop.ini"}

def stable_id(prefix, value):
    return prefix + "_" + hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()[:16]

def clean_title(stem):
    value = re.sub(r"[_]+", " ", stem)
    value = re.sub(r"\s+", " ", value).strip(" .-")
    return value or "Untitled"

def norm_stem(stem):
    normalized = unicodedata.normalize("NFKC", stem).casefold()
    # Preserve Unicode letters and numbers (including CJK); normalize only
    # punctuation and whitespace into one separator.
    chars = (" " if ch.isspace() or unicodedata.category(ch).startswith("P") else ch for ch in normalized)
    return re.sub(r"\s+", " ", "".join(chars)).strip()

def atomic_json(path, payload, mode=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if mode is not None:
            os.chmod(temp_name, mode)
        os.replace(temp_name, path)
        if mode is not None:
            os.chmod(path, mode)
    finally:
        try: os.unlink(temp_name)
        except FileNotFoundError: pass

def scan(root):
    found = []
    invalid = 0
    for base, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not os.path.islink(os.path.join(base, d)))
        for name in sorted(names):
            full = Path(base) / name
            if name.startswith(".") or name.casefold() in SYSTEM_NAMES or full.is_symlink():
                continue
            ext = full.suffix.casefold()
            if ext not in SUPPORTED:
                continue
            try:
                info = full.lstat()
                if not stat.S_ISREG(info.st_mode):
                    invalid += 1
                    continue
                rel = full.relative_to(root).as_posix()
                found.append({"path": rel, "size": info.st_size, "mtime_ns": info.st_mtime_ns, "extension": ext})
            except OSError:
                invalid += 1
    return found, invalid

def read_snapshot(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not isinstance(data.get("files"), list):
        raise ValueError("snapshot must contain a files array")
    out = []
    invalid = 0
    for item in data["files"]:
        if not isinstance(item, dict):
            invalid += 1
            continue
        rel = item.get("path")
        ext = str(item.get("extension") or "").casefold()
        if ext and ext != "(none)" and not ext.startswith("."):
            ext = "." + ext
        try:
            p = Path(str(rel))
            size = int(item["size"])
            mtime = int(item.get("mtime_ns", item.get("mtimeNs", 0)))
            hidden_or_system = any(part.startswith(".") or part.casefold() in SYSTEM_NAMES | {"__macosx", "$recycle.bin", "system volume information"} for part in p.parts)
            if hidden_or_system:
                continue
            if not rel or p.is_absolute() or ".." in p.parts:
                invalid += 1
                continue
            suffix = p.suffix.casefold()
            if suffix not in SUPPORTED and ext not in SUPPORTED:
                continue
            if ext not in SUPPORTED or suffix not in SUPPORTED or suffix != ext or size < 0:
                invalid += 1
                continue
            out.append({"path": p.as_posix(), "size": size, "mtime_ns": mtime, "extension": ext})
        except (KeyError, TypeError, ValueError):
            invalid += 1
            continue
    return out, invalid

def load_overrides(path):
    path = Path(path)
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as stream:
        data = json.load(stream)
    return load_overrides_from_data(data)

def load_overrides_from_data(data):
    if isinstance(data, dict) and "books" in data:
        if data.get("schemaVersion") != 1 or not isinstance(data["books"], dict):
            raise ValueError("overrides must use schemaVersion 1 and a books object")
        data = data["books"]
    if not isinstance(data, dict):
        raise ValueError("overrides must be an object keyed by book ID")
    allowed = {"title", "author", "description", "tags", "category"}
    validated = {}
    for book_id, fields in data.items():
        if not isinstance(book_id, str) or not isinstance(fields, dict):
            continue
        edits = {}
        for key in allowed.intersection(fields):
            value = fields[key]
            if key == "author" and value is None:
                edits[key] = None
                continue
            if key == "tags":
                if not isinstance(value, list) or len(value) > 20 or any(not isinstance(tag, str) or len(tag) > 80 for tag in value):
                    raise ValueError(f"invalid tags override for {book_id}")
                edits[key] = value
                continue
            limits = {"title": 500, "author": 200, "description": 5000, "category": 200}
            if not isinstance(value, str) or len(value) > limits[key] or (key in {"title", "category"} and not value.strip()):
                raise ValueError(f"invalid {key} override for {book_id}")
            edits[key] = value.strip() if key in {"title", "author", "category"} else value
        # categoryId, IDs, files, and any unrecognized fields are never trusted.
        validated[book_id] = edits
    return validated

def make_catalog(root, entries, source_status, threshold, invalid, overrides=None):
    root = Path(root).resolve()
    categories = {}
    groups = {}
    private_files = {}
    catalog_files = 0
    total_bytes = candidate_bytes = candidate_files = local_only = 0
    for entry in entries:
        rel = Path(entry["path"])
        fmt = SUPPORTED[entry["extension"]]
        size = entry["size"]
        # Snapshot paths are still checked against the current source tree before inclusion.
        src = root / rel
        try:
            resolved = src.resolve(strict=True)
            if src.is_symlink() or not resolved.is_relative_to(root) or not src.is_file():
                invalid += 1
                continue
            actual = src.lstat()
            if source_status == "scanned" and (actual.st_size != size or actual.st_mtime_ns != entry["mtime_ns"]):
                invalid += 1
                continue
            # Snapshot metadata is observational; retain its stated values, but confirm file exists.
        except (OSError, RuntimeError):
            invalid += 1
            continue
        size = max(0, int(size))
        drifted = source_status == "snapshot" and (actual.st_size != size or actual.st_mtime_ns != int(entry["mtime_ns"]))
        stem = rel.stem
        # Same directory and normalized stem is the entire grouping boundary.
        group_key = rel.parent.as_posix() + "\0" + norm_stem(stem)
        book_id = stable_id("book", group_key)
        category_name = rel.parts[0] if len(rel.parts) > 1 else "未分类"
        category_id = stable_id("cat", category_name.casefold())
        status = "unavailable" if size == 0 or drifted else ("candidate" if size <= threshold else "local_only")
        reason = "empty" if size == 0 else ("changed" if drifted else ("not_uploaded" if status == "candidate" else "size"))
        if size == 0:
            invalid += 1
        file_id = stable_id("file", rel.as_posix())
        file_row = {"id": file_id, "format": fmt, "sizeBytes": size, "status": status, "reason": reason,
                    "visibility": "private", "readable": fmt in READABLE}
        group = groups.setdefault(book_id, {"id": book_id, "title": clean_title(stem), "author": None,
            "category": category_name, "categoryId": category_id, "tags": [], "description": "", "files": []})
        group["files"].append(file_row)
        private_files[file_id] = {"path": str(src.resolve()), "bookId": book_id, "format": fmt,
            # JavaScript Number cannot exactly represent nanosecond timestamps;
            # serialize as decimal text for lossless BigInt comparison.
            "sizeBytes": size, "mtimeNs": str(int(entry["mtime_ns"])), "eligibility": status,
            "storageKey": None, "textPath": None, "visibility": "private"}
        catalog_files += 1
        total_bytes += size
        if status == "candidate": candidate_bytes += size; candidate_files += 1
        elif status == "local_only": local_only += 1
    for book_id, book in groups.items():
        for key, value in (overrides or {}).get(book_id, {}).items():
            book[key] = value
        book["categoryId"] = stable_id("cat", book["category"].casefold())
        row = categories.setdefault(book["categoryId"], {"id": book["categoryId"], "name": book["category"], "count": 0})
        row["count"] += 1
        book["files"].sort(key=lambda x: (x["format"], x["id"]))
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    catalog = {"schemaVersion": 1, "generatedAt": now, "sourceStatus": source_status, "thresholdBytes": threshold,
        "stats": {"books": len(groups), "files": catalog_files, "totalBytes": total_bytes,
                  "candidateBytes": candidate_bytes, "candidateFiles": candidate_files,
                  "localOnlyFiles": local_only, "invalidFiles": invalid},
        "categories": sorted(categories.values(), key=lambda c: (c["name"].casefold(), c["id"])),
        "books": sorted(groups.values(), key=lambda b: (b["title"].casefold(), b["id"]))}
    manifest = {"schemaVersion": 1, "root": str(root.resolve()), "generatedAt": now, "files": private_files}
    return catalog, manifest

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, help="source library root")
    parser.add_argument("--snapshot", help="optional inventory snapshot JSON")
    parser.add_argument("--output", default="data/catalog.json")
    parser.add_argument("--private-output", default=".local/manifest.json")
    parser.add_argument("--overrides", default=".local/overrides.json", help="optional owner metadata overrides")
    parser.add_argument("--threshold", type=int, default=20_000_000)
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        parser.error("--root must be a directory")
    if args.threshold < 0:
        parser.error("--threshold must be non-negative")
    invalid = 0
    if args.snapshot:
        entries, invalid = read_snapshot(args.snapshot)
        status = "snapshot"
    else:
        entries, invalid = scan(root)
        status = "scanned"
    try:
        overrides = load_overrides(args.overrides)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        parser.error(f"cannot read metadata overrides: {exc}")
    catalog, manifest = make_catalog(root, entries, status, args.threshold, invalid, overrides)
    atomic_json(args.output, catalog)
    atomic_json(args.private_output, manifest, 0o600)
    s = catalog["stats"]
    print(json.dumps({"sourceStatus": status, "books": s["books"], "files": s["files"],
        "totalBytes": s["totalBytes"], "candidateFiles": s["candidateFiles"],
        "localOnlyFiles": s["localOnlyFiles"], "invalidFiles": s["invalidFiles"],
        "output": str(Path(args.output)), "privateOutput": str(Path(args.private_output))}, ensure_ascii=False))

if __name__ == "__main__":
    main()
