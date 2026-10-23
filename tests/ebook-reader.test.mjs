import test from "node:test";
import { deflateRawSync } from "node:zlib";
import assert from "node:assert/strict";
import { LIMITS, inspectMobi, unzipEpub } from "../src/lib/ebook/archive.mjs";
import { extractBook } from "../src/lib/ebook/parse-worker.mjs";
import {
  readBoundedResponse,
  supportsReader,
} from "../src/lib/ebook/reader.mjs";
import {
  mobiFixture,
  kf8Fixture,
  epubFixture,
  epubEntries,
  zipFixture,
  palmDocAmplificationFixture,
} from "./fixtures/ebook/synthetic.mjs";
test("synthetic original MOBI6 and PalmDOC parse chapters as raw text without DOM or URLs", async () => {
  for (const compressed of [false, true]) {
    const b = await extractBook(mobiFixture({ compressed }), "MOBI");
    assert.equal(b.chapters.length, 2);
    assert.match(b.chapters[0].html, /Original MOBI text/);
    assert.match(b.chapters[1].html, /Second chapter/);
  }
});
test("synthetic original KF8/AZW3 fragment and skeleton records parse", async () => {
  for (const suffix of ["AZW3", "AZW", "MOBI"]) {
    const b = await extractBook(kf8Fixture(), suffix);
    assert.equal(b.chapters.length, 1);
    assert.match(b.chapters[0].html, /Synthetic KF8/);
    assert.match(b.chapters[0].html, /Original AZW3 fragment/);
  }
});
test("AZW suffix does not override content format and encrypted MOBI is rejected", async () => {
  assert.throws(() => inspectMobi(epubFixture()), /不是支持/);
  for (const fixture of [mobiFixture(), kf8Fixture()]) {
    const v = new DataView(fixture.buffer),
      offset = v.getUint32(78);
    v.setUint16(offset + 12, 2);
    await assert.rejects(extractBook(fixture, "AZW"), /DRM/);
  }
});
test("HUFF/CDIC explicitly rejected before upstream decompression", () => {
  const b = mobiFixture(),
    v = new DataView(b.buffer);
  v.setUint16(v.getUint32(78), 17480);
  assert.throws(() => inspectMobi(b), /HUFF\/CDIC/);
});
test("MOBI structural counts and expansion limits fail closed", () => {
  const b = mobiFixture(),
    v = new DataView(b.buffer);
  v.setUint16(76, 65535);
  assert.throws(() => inspectMobi(b), /记录表/);
  const large = new Uint8Array(LIMITS.file + 1);
  assert.throws(() => inspectMobi(large), /20 MB/);
});
test("synthetic EPUB ZIP is read locally including original malicious fixture for sanitizer", async () => {
  const files = new Map(await unzipEpub(epubFixture()));
  assert.match(files.get("OPS/one.xhtml"), /Original synthetic/);
  assert.match(files.get("OPS/two.xhtml"), /<script>/);
});
test("EPUB encryption, traversal, duplicate entries and wrong MIME fail closed", async () => {
  for (const entries of [
    [...epubEntries(), ["META-INF/encryption.xml", "<encryption/>"]],
    [...epubEntries(), ["../outside.xml", "x"]],
    [...epubEntries(), ["OPS/one.xhtml", "x"]],
    epubEntries().map(([n, t]) => [n, n === "mimetype" ? "text/plain" : t]),
  ])
    await assert.rejects(unzipEpub(zipFixture(entries)));
});
test("EPUB advertised expansion and malformed central directory rejected", async () => {
  const b = epubFixture(),
    v = new DataView(b.buffer),
    end = b.length - 22,
    cd = v.getUint32(end + 16, true);
  v.setUint32(cd + 24, LIMITS.entry + 1, true);
  await assert.rejects(unzipEpub(b), /安全限制/);
  await assert.rejects(unzipEpub(new Uint8Array([1, 2, 3])), /损坏/);
});
test("bounded response rejects absent/empty/oversized and cancellation retains no stream", async () => {
  assert.equal((await readBoundedResponse(new Response("test"))).byteLength, 4);
  await assert.rejects(readBoundedResponse(new Response("")), /为空/);
  await assert.rejects(
    readBoundedResponse(
      new Response("x", {
        headers: { "content-length": String(LIMITS.file + 1) },
      }),
    ),
    /20 MB/,
  );
  let cancelled = false;
  const stream = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(LIMITS.file + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readBoundedResponse(new Response(stream)), /安全限制/);
  assert.equal(cancelled, true);
});
test("only supported family is advertised", () => {
  for (const f of ["PDF", "epub", "MOBI", "AZW", "azw3"])
    assert.equal(supportsReader(f), true);
  assert.equal(supportsReader("KFX"), false);
});

test("deflated EPUB streaming decode works and lying advertised expansion is stopped", async () => {
  const zipped = zipFixture(epubEntries(), deflateRawSync),
    files = new Map(await unzipEpub(zipped));
  assert.match(files.get("OPS/one.xhtml"), /Original synthetic/);
  const bomb = zipFixture(
      [...epubEntries(), ["OPS/large.xhtml", "a".repeat(400000)]],
      deflateRawSync,
    ),
    v = new DataView(bomb.buffer);
  let at = v.getUint32(bomb.length - 6, true);
  for (let i = 0; i < epubEntries().length; i++)
    at +=
      46 +
      v.getUint16(at + 28, true) +
      v.getUint16(at + 30, true) +
      v.getUint16(at + 32, true);
  v.setUint32(at + 24, 1, true);
  await assert.rejects(unzipEpub(bomb), /实际解压大小/);
});
test("MOBI DRM record count rejects even if PalmDOC encryption says zero", () => {
  const b = mobiFixture(),
    v = new DataView(b.buffer);
  v.setUint32(v.getUint32(78) + 172, 1);
  assert.throws(() => inspectMobi(b), /DRM/);
});

test("response deadline stops stalled reads and cancellation cannot hang or replace errors", async () => {
  for (const cancel of [
    () => Promise.reject(new Error("cancel rejected")),
    () => new Promise(() => {}),
  ]) {
    const never = new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel,
    });
    await assert.rejects(
      readBoundedResponse(new Response(never), { timeoutMs: 5 }),
      /读取超时/,
    );
    const huge = new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(LIMITS.file + 1));
      },
      cancel,
    });
    await assert.rejects(
      readBoundedResponse(new Response(huge), { timeoutMs: 500 }),
      /安全限制/,
    );
  }
});

test("standard MOBI6 232-byte header remains supported", async () => {
  const b = mobiFixture(),
    v = new DataView(b.buffer);
  v.setUint32(v.getUint32(78) + 20, 232);
  const book = await extractBook(b, "MOBI");
  assert.match(book.chapters[0].html, /Original MOBI text/);
});

test("EPUB encryption metadata is rejected before any deflate decoding", async () => {
  const b = zipFixture(
      [...epubEntries(), ["META-INF/encryption.xml", "<encryption/>"]],
      deflateRawSync,
    ),
    v = new DataView(b.buffer),
    start = 30 + v.getUint16(26, true);
  b[start] = 255;
  await assert.rejects(unzipEpub(b), /加密资源/);
});

test("declared oversized response cancels without reading or awaiting broken cancellation", async () => {
  for (const mode of ["reject", "hang"]) {
    let cancelled = false,
      read = false;
    const response = {
      headers: new Headers({ "content-length": String(LIMITS.file + 1) }),
      body: {
        cancel() {
          cancelled = true;
          return mode === "reject"
            ? Promise.reject(new Error("broken cancel"))
            : new Promise(() => {});
        },
        getReader() {
          read = true;
          throw new Error("must not read oversized body");
        },
      },
    };
    await assert.rejects(readBoundedResponse(response), /20 MB/);
    assert.equal(cancelled, true);
    assert.equal(read, false);
  }
});

test("hostile KF8 FDST and index 32-bit counts fail before materializing arrays", async () => {
  const mutations = [
    (v, o, b) => {
      v.setUint32(o(0) + 192, 2);
      b.set(new TextEncoder().encode("FDST"), o(2));
      v.setUint32(o(2) + 8, 0xffffffff);
    },
    (v, o) => v.setUint32(o(2) + 60, 0xffffffff),
    (v, o) => v.setUint32(o(2) + 24, 0xffffffff),
    (v, o) => v.setUint32(o(2) + 52, 0xffffffff),
    (v, o) => v.setUint32(o(3) + 24, 0xffffffff),
    (v, o) => v.setUint32(o(3) + 20, 0xffffffff),
    (v, o) => v.setUint32(o(2) + 64, 0xffffffff),
    (v, o, b) => {
      b[o(2) + 70] = 0;
    },
  ];
  for (const mutate of mutations) {
    const b = kf8Fixture(),
      v = new DataView(b.buffer),
      o = (i) => v.getUint32(78 + i * 8);
    mutate(v, o, b);
    await assert.rejects(extractBook(b, "AZW3"), /结构无效|安全限制/);
  }
});
test("KF8 malicious lengths, record exhaustion and insertion offsets stay bounded", async () => {
  for (const options of [
    { skelLength: 16000001 },
    { skelLength: 4096 },
    { skelOffset: 1000, skelLength: 100 },
    { fragmentOffset: 16000000 },
    { insertOffset: 16000000 },
  ])
    await assert.rejects(
      extractBook(kf8Fixture(options), "AZW3"),
      /结构无效|安全限制/,
    );
});
test("EXTH malicious count, MOBI chapter flood and PalmDOC expansion reject at bounded limits", async () => {
  const b = mobiFixture(),
    v = new DataView(b.buffer),
    header = v.getUint32(78);
  v.setUint32(header + 128, 64);
  b.set(new TextEncoder().encode("EXTH"), header + 264);
  v.setUint32(header + 268, 16);
  v.setUint32(header + 272, 0xffffffff);
  await assert.rejects(extractBook(b, "MOBI"), /结构无效|安全限制/);
  await assert.rejects(
    extractBook(mobiFixture({ text: "<pagebreak>".repeat(1025) }), "MOBI"),
    /结构无效|安全限制/,
  );
  await assert.rejects(
    extractBook(palmDocAmplificationFixture(), "MOBI"),
    /结构无效|安全限制/,
  );
});

test("KF8 huge or unterminated tag varints reject before value expansion", async () => {
  for (const last of [255, 127]) {
    const b = kf8Fixture({ skelLength: 16000000 }),
      v = new DataView(b.buffer),
      meta = v.getUint32(78 + 2 * 8),
      data = v.getUint32(78 + 3 * 8);
    b[meta + 70] = 3; // Multi-bit mask selects the valueBytes varint path.
    b.set([127, 127, 127, last], data + 59);
    await assert.rejects(extractBook(b, "AZW3"), /结构无效|安全限制/);
  }
});
