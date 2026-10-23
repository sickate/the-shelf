import test from "node:test";
import assert from "node:assert/strict";
import {
  bookTitle,
  canSubmitUploadBytes,
  formatForFilename,
  managementCapabilityText,
  managementUploadStatus,
  validateUploadFile,
} from "../src/lib/manage-ui.mjs";
import { fileExplanation } from "../src/lib/file-availability.mjs";

test("upload preflight permits only nonempty supported files within the per-file cap", () => {
  for (const name of [
    "novel.pdf",
    "book.EPUB",
    "sample.mobi",
    "file.azw",
    "file.azw3",
  ])
    assert.equal(validateUploadFile({ name, size: 10 }), null);
  assert.match(validateUploadFile({ name: "book.pdf", size: 0 }), /空文件/);
  assert.match(
    validateUploadFile({ name: "book.pdf", size: 20_000_001 }),
    /20 MB/,
  );
  assert.match(validateUploadFile({ name: "archive.zip", size: 10 }), /仅支持/);
  assert.equal(formatForFilename("folder.with.dot/BOOK.AZW3"), "AZW3");
});

test("upload capability text explains blocked server reasons and never claims readiness", () => {
  assert.match(
    managementCapabilityText({
      enabled: false,
      reasons: ["authority_not_ready", "storage_target_mismatch"],
    }),
    /存储用量核对.*普通上传存储/,
  );
  assert.match(
    managementCapabilityText({ enabled: false, reasons: [] }),
    /不会离开此设备/,
  );
  assert.match(
    managementCapabilityText({ enabled: true, code: "ready" }),
    /已就绪/,
  );
});

test("only a fresh reserved intent with explicit server permission can send bytes", () => {
  assert.equal(
    canSubmitUploadBytes({ state: "reserved", canSubmit: true }),
    true,
  );
  for (const intent of [
    { state: "reserved", canSubmit: false },
    { state: "reserved" },
    { state: "uploading", canSubmit: true },
    { state: "uncertain", canSubmit: true },
    { state: "confirmed", canSubmit: true },
    null,
  ])
    assert.equal(canSubmitUploadBytes(intent), false);
});

test("reloaded upload states are reported without offering an automatic retry", () => {
  assert.match(managementUploadStatus({ state: "reserved" }), /不会自动重传/);
  assert.match(managementUploadStatus({ state: "uncertain" }), /请勿再次提交/);
  assert.match(managementUploadStatus({ state: "uploading" }), /状态待确认/);
  assert.match(managementUploadStatus({ state: "confirmed" }), /私有存储确认/);
});

test("book title helper uses a visible fallback", () => {
  assert.equal(bookTitle({ title: "  " }), "未命名书籍");
  assert.equal(bookTitle({ title: "书名" }), "书名");
});

test("reader explanations distinguish DRM and Kindle compression constraints", () => {
  assert.match(fileExplanation({ format: "MOBI", readable: false }), /无 DRM/);
  assert.match(
    fileExplanation({ format: "AZW3", readable: false }),
    /HUFF\/CDIC/,
  );
  assert.match(
    fileExplanation({ format: "PDF", readable: false }),
    /支持浏览器阅读/,
  );
});
