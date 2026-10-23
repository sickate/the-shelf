import test from "node:test";
import assert from "node:assert/strict";
import { fileActions } from "../src/lib/file-actions.mjs";

class Element {
  constructor(tag, dataset = {}) {
    this.tagName = tag;
    this.dataset = dataset;
    this.children = [];
    this.parentElement = null;
    this.textContent = "";
  }
  append(child) {
    child.parentElement = this;
    this.children.push(child);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(
      (child) => child !== this,
    );
  }
  matches(selector) {
    const key = selector
      .slice(1, -1)
      .replace(/^data-/, "")
      .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return Object.hasOwn(this.dataset, key);
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) {
    if (selector.startsWith("["))
      return this.querySelectorAll(selector)[0] || null;
    const visit = (node) => {
      for (const child of node.children) {
        if (child.tagName === selector) return child;
        const nested = visit(child);
        if (nested) return nested;
      }
      return null;
    };
    return visit(this);
  }
  click() {
    this.onclick?.();
  }
}

function fixture({ mode = "same-origin", format = "PDF" } = {}) {
  const row = new Element("section", {
    fileRow: "",
    fileId: "file_1",
    fileFormat: format,
    fileSize: "50",
  });
  const status = new Element("span", { fileStatus: "" });
  status.textContent = "待上传 · 私有";
  const explanation = new Element("span", { fileExplanation: "" });
  explanation.textContent = "等待上传；目前不能在线阅读或下载。";
  const actions = new Element("div", { fileActions: "" });
  row.append(status);
  row.append(explanation);
  row.append(actions);
  const root = {
    querySelectorAll: (selector) =>
      selector === "[data-file-row]" ? [row] : [],
  };
  globalThis.document = {
    createElement: (tag) => new Element(tag),
  };
  return {
    row,
    status,
    explanation,
    actions,
    controller: fileActions({
      root,
      bookId: "book & one",
      readBase: "/",
      mode,
      onDownload: () => {},
    }),
  };
}

const file = (patch = {}) => ({
  id: "file_1",
  format: "PDF",
  sizeBytes: 50,
  status: "candidate",
  reason: "uploaded",
  visibility: "private",
  readable: true,
  ...patch,
});

test("file actions reconcile confirmed, revoked, malformed, disabled and local states", () => {
  const f = fixture();
  f.controller.apply([file({ reason: "not_uploaded" })]);
  assert.equal(f.actions.children.length, 0);

  f.controller.apply([file()]);
  assert.equal(f.actions.children.length, 2);
  assert.match(f.actions.children[0].href, /book=book%20%26%20one/);
  assert.equal(
    f.explanation.textContent,
    "文件已确认上传；读取与下载仍需所有者会话授权。",
  );
  f.controller.apply([file()]);
  assert.equal(f.actions.children.length, 2);
  f.controller.apply(undefined);
  assert.equal(f.actions.children.length, 0);
  assert.equal(f.status.textContent, "状态待核对");
  assert.equal(
    f.explanation.textContent,
    "当前文件状态暂不可核对，在线授权入口已隐藏，请刷新后重试。",
  );
  f.controller.apply([file()]);
  assert.equal(f.actions.children.length, 2);

  f.controller.apply([file({ reason: "not_uploaded" })]);
  assert.equal(f.actions.children.length, 0);
  assert.equal(f.status.textContent, "待上传 · 私有");
  assert.equal(f.explanation.textContent, "等待上传；目前不能在线阅读或下载。");
  for (const rejected of [
    [file({ format: "EPUB" })],
    [file({ sizeBytes: 20_000_001 })],
    [file(), file()],
    [{ ...file(), id: "unknown" }],
  ]) {
    f.controller.apply(rejected);
    assert.equal(f.actions.children.length, 0);
    assert.equal(f.status.textContent, "状态待核对");
  }
  f.controller.apply([file({ reason: "<img src=x onerror=alert(1)>" })]);
  assert.equal(f.actions.children.length, 0);
  assert.equal(f.explanation.textContent.includes("<img"), false);

  const disabled = fixture({ mode: "disabled" });
  disabled.controller.apply([file()]);
  assert.equal(disabled.actions.children.length, 0);

  const local = fixture({ mode: "" });
  local.controller.apply([file({ reason: "not_uploaded" })]);
  assert.equal(local.actions.children.length, 0);
});

test("no-DRM Kindle formats retain a reader link when the old readable flag is false", () => {
  const f = fixture({ format: "MOBI" });
  f.controller.apply([file({ format: "MOBI", readable: false })]);
  assert.equal(f.actions.children[0].textContent, "授权阅读 →");
});
