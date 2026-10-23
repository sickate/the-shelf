import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, NoOpLog, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";

// Every global fetch is intercepted by an in-process synthetic outbound service.
// No real AI, credentials, Cloudflare API, DNS or public network is used.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SYNTHETIC_HOST = "shelf-runtime-synthetic.invalid";
const KEY = "synthetic_private_key_123456789";
const worker = `
import { callIdentifyTask } from "../cloudflare/library/identify.mjs";
const target = "https://${SYNTHETIC_HOST}";
export default { async fetch(request) {
  const mode = new URL(request.url).pathname.slice(1);
  if (mode === "construct_error") {
    try { new Request(target + "/success", { redirect: "error" });
      return Response.json({ result: "unexpected_success" });
    } catch (error) {
      return Response.json({ result: error instanceof TypeError ? "type_error" : "other_error" });
    }
  }
  if (mode === "fetch_error" || mode === "fetch_manual" || mode === "redirect_manual") {
    try {
      const response = await fetch(target + (mode === "redirect_manual" ? "/redirect" : "/success"), {
        method: "POST", redirect: mode === "fetch_error" ? "error" : "manual",
        headers: { Authorization: "Bearer ${KEY}" }, body: "synthetic"
      });
      const status = response.status;
      await response.body?.cancel();
      return Response.json({ result: "response", status });
    } catch (error) {
      return Response.json({ result: error instanceof TypeError ? "type_error" : "other_error" });
    }
  }
  try {
    const value = await callIdentifyTask("${KEY}", "Synthetic Valley.pdf", {
      timeoutMs: mode === "adapter_timeout" ? 2 : 1000,
      ...(mode === "adapter_fetch_error" ? { fetchImpl: async () => { throw new TypeError("synthetic_fetch_failure"); } } : {}),
      ...(mode === "adapter_timeout" ? { fetchImpl: () => new Promise(() => {}) } : {})
    });
    return Response.json({ result: "completed", phase: value.diagnostic.phase, httpStatus: value.diagnostic.httpStatus });
  } catch (error) {
    // Fixed allowlisted output only. Never read or return error.message/stack.
    return Response.json({ result: "adapter_rejected", phase: error.diagnostic?.phase ?? "missing", httpStatus: error.diagnostic?.httpStatus ?? null });
  }
}};
`;

test("workerd rejects redirect:error before dispatch; manual permits synthetic requests and stops redirects", async (t) => {
  const observed = [],
    followed = [];
  let activeMode;
  const bundled = await build({
    stdin: {
      contents: worker,
      resolveDir: path.join(ROOT, "tests"),
      sourcefile: "synthetic-identify-runtime-worker.mjs",
    },
    bundle: true,
    write: false,
    platform: "neutral",
    format: "esm",
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      log: new NoOpLog(),
      compatibilityDate: "2026-10-15",
      modules: true,
      rootPath: ROOT,
      scriptPath: path.join(
        ROOT,
        "tests",
        "synthetic-identify-runtime-worker.mjs",
      ),
      script: bundled.outputFiles[0].text,
      async outboundService(request) {
        const url = new URL(request.url);
        if (url.hostname === "shelf-runtime-redirect.invalid") {
          followed.push({
            authorization: request.headers.has("authorization"),
            bodyBytes: (await request.arrayBuffer()).byteLength,
          });
          return new Response(null, { status: 500 });
        }
        // Global outbound routing terminates here; this never forwards any request.
        assert.ok(
          url.hostname === SYNTHETIC_HOST ||
            (url.hostname === "oai.parallelstreamllc.com" &&
              url.pathname === "/v1/tasks"),
        );
        assert.equal(request.headers.get("authorization"), `Bearer ${KEY}`);
        const redirectStatus = activeMode.startsWith("adapter_redirect_")
          ? Number(activeMode.slice("adapter_redirect_".length))
          : null;
        const route =
          url.pathname === "/v1/tasks"
            ? redirectStatus
              ? `/redirect_${redirectStatus}`
              : "/success"
            : url.pathname;
        observed.push(route);
        if (route === "/redirect" || redirectStatus)
          return new Response(null, {
            status: redirectStatus || 302,
            headers: {
              Location: "https://shelf-runtime-redirect.invalid/never",
            },
          });
        assert.equal(route, "/success");
        return Response.json({
          task_id: "synthetic_task",
          kind: "research_summary",
          model: "gpt-6-luna",
          content: JSON.stringify({
            title: "Synthetic Valley",
            author: null,
            category: null,
          }),
          usage: null,
        });
      },
    }),
  );
  t.after(() => mf.dispose());
  const run = async (mode) => {
    activeMode = mode;
    return (
      await mf.dispatchFetch(`https://entry-synthetic.invalid/${mode}`)
    ).json();
  };

  assert.deepEqual(await run("construct_error"), { result: "type_error" });
  assert.equal(observed.length, 0);
  assert.deepEqual(await run("fetch_error"), { result: "type_error" });
  assert.equal(observed.length, 0);
  for (const [mode, phase] of [
    ["adapter_fetch_error", "fetch_error"],
    ["adapter_timeout", "timeout"],
  ]) {
    assert.deepEqual(await run(mode), {
      result: "adapter_rejected",
      phase,
      httpStatus: null,
    });
    assert.equal(observed.length, 0);
  }
  assert.deepEqual(await run("adapter_current"), {
    result: "completed",
    phase: "completed",
    httpStatus: 200,
  });
  assert.equal(observed.length, 1);
  assert.deepEqual(await run("fetch_manual"), {
    result: "response",
    status: 200,
  });
  assert.equal(observed.length, 2);
  assert.deepEqual(await run("redirect_manual"), {
    result: "response",
    status: 302,
  });
  assert.equal(observed.length, 3);
  for (const status of [302, 307, 308]) {
    const before = observed.length;
    assert.deepEqual(await run(`adapter_redirect_${status}`), {
      result: "adapter_rejected",
      phase: "http_status",
      httpStatus: status,
    });
    assert.equal(observed.length, before + 1);
    assert.deepEqual(followed, []);
  }
  assert.deepEqual(observed, [
    "/success",
    "/success",
    "/redirect",
    "/redirect_302",
    "/redirect_307",
    "/redirect_308",
  ]);
  assert.deepEqual(followed, []);
});
