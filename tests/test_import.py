import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "import-books.py"
spec = importlib.util.spec_from_file_location("import_books", SCRIPT)
imp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(imp)


class ImportBooksTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "library"
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def put(self, rel, size):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x" * size)
        return p

    def build(self, entries=None):
        if entries is None:
            entries, invalid = imp.scan(self.root)
        else:
            invalid = 0
        return imp.make_catalog(self.root, entries, "scanned", 20_000_000, invalid)

    def test_threshold_zero_and_large_entries_are_retained(self):
        self.put("Fiction/edge.pdf", 20_000_000)
        self.put("Fiction/large.pdf", 20_000_001)
        self.put("Fiction/empty.epub", 0)
        catalog, manifest = self.build()
        by_title = {b["title"]: b for b in catalog["books"]}
        statuses = {title: book["files"][0]["status"] for title, book in by_title.items()}
        self.assertEqual(statuses, {"edge": "candidate", "large": "local_only", "empty": "unavailable"})
        self.assertEqual(catalog["stats"]["files"], 3)
        self.assertEqual(catalog["stats"]["candidateFiles"], 1)
        self.assertEqual(catalog["stats"]["invalidFiles"], 1)
        self.assertEqual(len(manifest["files"]), 3)

    def test_same_directory_stem_groups_formats_and_public_data_is_private_safe(self):
        self.put("Sci-Fi/Dune.PDF", 4)
        self.put("Sci-Fi/Dune.epub", 3)
        self.put("Other/Dune.mobi", 5)
        catalog, manifest = self.build()
        self.assertEqual(len(catalog["books"]), 2)
        dune = next(b for b in catalog["books"] if b["category"] == "Sci-Fi")
        self.assertEqual({f["format"] for f in dune["files"]}, {"PDF", "EPUB"})
        public = json.dumps(catalog)
        self.assertNotIn(str(self.root), public)
        self.assertNotIn("mtimeNs", public)
        self.assertNotIn("storageKey", public)
        self.assertNotIn("textPath", public)
        private_file = next(iter(manifest["files"].values()))
        self.assertIn("path", private_file)
        self.assertIsInstance(private_file["mtimeNs"], str)
        self.assertGreater(int(private_file["mtimeNs"]), 2**53)
        encoded = json.loads(json.dumps(manifest))
        self.assertEqual(encoded["files"][next(iter(encoded["files"]))]["mtimeNs"], private_file["mtimeNs"])

    def test_cjk_titles_stay_distinct_and_unicode_compatibility_forms_group(self):
        self.put("中文/书一.pdf", 1)
        self.put("中文/书二.epub", 1)
        self.put("中文/ＡＢＣ.PDF", 1)
        self.put("中文/abc.epub", 1)
        catalog, _ = self.build()
        self.assertEqual(len(catalog["books"]), 3)
        books = {b["title"]: b for b in catalog["books"]}
        self.assertNotEqual(books["书一"]["id"], books["书二"]["id"])
        latin = next(book for book in catalog["books"] if {f["format"] for f in book["files"]} == {"PDF", "EPUB"})
        self.assertEqual(len(latin["files"]), 2)

    def test_manual_metadata_overrides_survive_reimport_without_exposing_paths(self):
        self.put("Fiction/Original.epub", 4)
        entries, invalid = imp.scan(self.root)
        initial, _ = imp.make_catalog(self.root, entries, "scanned", 20_000_000, invalid)
        book_id = initial["books"][0]["id"]
        overrides = imp.load_overrides_from_data({"schemaVersion": 1, "books": {book_id: {
            "title": "Corrected title", "author": "Known author", "description": "Owner note",
            "tags": ["favorite", "history"], "category": "Personal picks", "categoryId": "untrusted",
            "id": "untrusted", "files": [{"path": str(self.root)}],
        }}})
        reimported, manifest = imp.make_catalog(self.root, entries, "scanned", 20_000_000, invalid, overrides)
        corrected = reimported["books"][0]
        self.assertEqual(corrected["id"], book_id)
        self.assertEqual((corrected["title"], corrected["author"], corrected["description"]),
                         ("Corrected title", "Known author", "Owner note"))
        self.assertEqual(corrected["tags"], ["favorite", "history"])
        self.assertEqual(corrected["category"], "Personal picks")
        self.assertEqual(corrected["categoryId"], imp.stable_id("cat", "personal picks"))
        self.assertEqual(reimported["categories"], [{"id": corrected["categoryId"], "name": "Personal picks", "count": 1}])
        self.assertNotIn(str(self.root), json.dumps(reimported))
        self.assertTrue(all(f["bookId"] == book_id for f in manifest["files"].values()))

    def test_override_bounds_are_validated(self):
        with self.assertRaises(ValueError):
            imp.load_overrides_from_data({"book": {"description": "x" * 5001}})

    def test_hidden_unknown_and_symlink_escape_are_ignored(self):
        self.put("visible/book.pdf", 2)
        self.put(".hidden/secret.epub", 3)
        self.put("visible/.hidden.epub", 4)
        self.put("visible/unknown.txt", 8)
        outside = Path(self.temp.name) / "outside.epub"
        outside.write_bytes(b"secret")
        try:
            (self.root / "visible" / "escape.epub").symlink_to(outside)
        except OSError:
            pass
        entries, invalid = imp.scan(self.root)
        self.assertEqual([e["path"] for e in entries], ["visible/book.pdf"])
        snap = [{"path": "visible/escape.epub", "size": 6, "mtime_ns": 0, "extension": ".epub"}]
        catalog, manifest = imp.make_catalog(self.root, snap, "snapshot", 20_000_000, 0)
        self.assertEqual(catalog["stats"]["files"], 0)
        self.assertEqual(catalog["stats"]["invalidFiles"], 1)
        self.assertEqual(manifest["files"], {})

    def test_snapshot_filters_hidden_and_extension_mismatch_and_marks_drift_unavailable(self):
        current = self.put("visible/Book.pdf", 10)
        snapshot = Path(self.temp.name) / "snapshot.json"
        snapshot.write_text(json.dumps({"files": [
            {"path": ".hidden/book.pdf", "size": 1, "mtime_ns": 1, "extension": ".pdf"},
            {"path": "visible/wrong.epub", "size": 1, "mtime_ns": 1, "extension": ".pdf"},
            {"path": "visible/Book.pdf", "size": 10, "mtime_ns": 1, "extension": "PDF"},
        ]}), encoding="utf-8")
        entries, rejected = imp.read_snapshot(snapshot)
        self.assertEqual(len(entries), 1)
        self.assertEqual(rejected, 1)
        catalog, _ = imp.make_catalog(self.root, entries, "snapshot", 20_000_000, rejected)
        file_row = catalog["books"][0]["files"][0]
        self.assertEqual(file_row["status"], "unavailable")
        self.assertEqual(file_row["reason"], "changed")
        self.assertEqual(catalog["stats"]["candidateFiles"], 0)

    def test_atomic_private_output_has_restricted_permissions(self):
        output = Path(self.temp.name) / "private.json"
        imp.atomic_json(output, {"ok": True}, 0o600)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
