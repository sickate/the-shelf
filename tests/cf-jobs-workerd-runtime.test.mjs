import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, NoOpLog, convertV4MiniflareOptions } from "miniflare";
import { jobsFixture, seedSQL, NOW } from "./helpers/jobs-fixture.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Only in-memory test entry points, with real workerd D1 and no forwarded fetch.
const entry = `
import {createJobsState} from "../cloudflare/library/jobs-state.mjs";
let state,lost=false,currentTime=1792742400000;const tokens=new Map(),contexts=new Map();
const plan={phase:"question",inputHash:"c".repeat(64),inputCodepoints:20,requestBytes:100,coverage:[]};
const complete={outcome:"completed",content:"Synthetic runtime answer",usage:null,coverage:[]};
export default {async fetch(request,env){
 try{
  if(!state)state=createJobsState({prepare:(...a)=>env.DB.prepare(...a),withSession:(...a)=>env.DB.withSession(...a),async batch(s){const r=await env.DB.batch(s);if(lost){lost=false;throw Error("synthetic lost batch response");}return r;}},{clock:()=>currentTime});
  const url=new URL(request.url),v=await request.json();
  if(url.pathname==="/budget")return Response.json(await state.sharedBudget());
  if(url.pathname==="/cancel"){const j=await state.getJob(v.id);return Response.json(await state.cancelJob(v.id,j.version));}
  if(url.pathname==="/replay"){const j=await state.getJob(v.id),a=await state.claimCall(v.id,1,j.version,"d".repeat(64));return Response.json({job:a.job,permit:a.permit!==null});}
  if(url.pathname==="/lost-admit")lost=true;
  const a=await state.admitJob(v.input,v.grant);
  if(a.permit)tokens.set(a.job.id,a.permit);
  if(url.pathname==="/admit"||url.pathname==="/lost-admit")return Response.json({job:a.job,permit:a.permit!==null});
  const token=tokens.get(a.job.id);
  if(!token)return Response.json({error:"synthetic_missing_token"},{status:409});
  let cloneRejected=false;
  try{await state.consumePermit(JSON.parse(JSON.stringify(token)),()=>{});}catch{cloneRejected=true;}
  await state.consumePermit(token,c=>{contexts.set(a.job.id,c);});tokens.delete(a.job.id);
  let j=await state.startPlanning(a.job.id,a.job.version);j=await state.savePlan(j.id,j.version,[plan]);
  if(url.pathname==="/lost-dispatch")lost=true;
  const claim=await state.claimCall(j.id,1,j.version,"d".repeat(64));
  if(!claim.permit)return Response.json({job:claim.job,permit:false,cloneRejected});
  if(url.pathname==="/delay-cancel")await state.cancelJob(j.id,claim.job.version);
  let calls=0,twiceRejected=false,terminalDoubleRejected=false;
  await state.consumePermit(claim.permit,async context=>{
   calls++;const response=await fetch("https://jobs-synthetic.invalid/one",{method:"POST",redirect:"manual",body:"synthetic"});await response.body.cancel();
   if(url.pathname==="/cancel-in-flight")await state.cancelJob(j.id,claim.job.version);
   if(url.pathname==="/late-success")currentTime+=900001;
   if(url.pathname==="/terminal-double"){
    const results=await Promise.allSettled([state.finishCall(context,complete),state.finishCall(context,{...complete,content:"Different synthetic answer"})]);
    j=results.find(v=>v.status==="fulfilled").value;
    terminalDoubleRejected=results.filter(v=>v.status==="fulfilled").length===1&&results.find(v=>v.status==="rejected").reason.code==="jobs_permit_invalid";
   }else j=await state.finishCall(context,complete);
  });
  try{await state.consumePermit(claim.permit,()=>{calls++;});}catch{twiceRejected=true;}
  j=await state.recordWorkflowOutcome(contexts.get(j.id),"created");
  const receipt=await env.DB.prepare("SELECT usable FROM shelf_job_call_receipts WHERE job_id=?").bind(j.id).first();
  return Response.json({job:j,calls,twiceRejected,cloneRejected,terminalDoubleRejected,usable:receipt.usable});
 }catch(error){return Response.json({error:error.code||"synthetic_runtime_error"},{status:409});}
}};
`;
function splitSQL(sql) {
  const out = [];
  let text = "",
    word = "",
    quote = null,
    lineComment = false,
    blockComment = false,
    depth = 0;
  const flush = () => {
    const w = word.toUpperCase();
    if (w === "BEGIN" || w === "CASE") depth++;
    else if (w === "END") depth--;
    word = "";
  };
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i],
      next = sql[i + 1];
    if (lineComment) {
      if (c === "\n") {
        lineComment = false;
        text += "\n";
      }
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      text += c;
      if (c === quote) {
        if (next === quote) {
          text += next;
          i++;
        } else quote = null;
      }
      continue;
    }
    if (c === "-" && next === "-") {
      flush();
      lineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      flush();
      blockComment = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      flush();
      quote = c;
      text += c;
      continue;
    }
    if (/[a-z_]/i.test(c)) word += c;
    else flush();
    text += c;
    if (c === ";" && depth === 0) {
      if (text.trim()) out.push(text.trim());
      text = "";
    }
  }
  flush();
  if (text.trim()) out.push(text.trim());
  assert.equal(depth, 0);
  assert.equal(quote, null);
  return out;
}
async function runtime(t) {
  const f = await jobsFixture(t),
    observed = [];
  assert.equal(f.now, NOW);
  const bundle = await build({
    stdin: {
      contents: entry,
      resolveDir: path.join(ROOT, "tests"),
      sourcefile: "synthetic-jobs-runtime.mjs",
    },
    bundle: true,
    write: false,
    platform: "neutral",
    format: "esm",
  });
  const worker = (name) => ({
    name,
    modules: true,
    compatibilityDate: "2026-10-15",
    rootPath: ROOT,
    scriptPath: path.join(
      ROOT,
      "tests",
      "synthetic-jobs-runtime-" + name + ".mjs",
    ),
    script: bundle.outputFiles[0].text,
    d1Databases: { DB: "jobs-synthetic-shared" },
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.hostname, "jobs-synthetic.invalid");
      assert.equal(url.pathname, "/one");
      assert.equal(await request.text(), "synthetic");
      observed.push("POST synthetic");
      return new Response("synthetic");
    },
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      log: new NoOpLog(),
      workers: [worker("a"), worker("b")],
    }),
  );
  t.after(() => mf.dispose());
  const d1 = await mf.getD1Database("DB", "a");
  for (const s of splitSQL(seedSQL(f))) await d1.prepare(s).run();
  const workers = await Promise.all(
    ["a", "b"].map((name) => mf.getWorker(name)),
  );
  const run = async (index, route, n = 1, extra = {}) => {
    const response = await workers[index].fetch(
      "https://entry-synthetic.invalid/" + route,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: f.input(n), grant: f.grant, ...extra }),
      },
    );
    return { status: response.status, ...(await response.json()) };
  };
  return { f, mf, d1, run, observed };
}
test("workerd actual D1: competing isolates share one creation permit and one synthetic dispatch", async (t) => {
  const r = await runtime(t),
    a = await Promise.all([r.run(0, "admit"), r.run(1, "admit")]);
  assert.equal(a.filter((v) => v.permit).length, 1);
  assert.equal(a[0].job.id, a[1].job.id);
  const winner = a[0].permit ? 0 : 1,
    done = await r.run(winner, "run");
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.equal(done.job.state, "completed");
  assert.equal(done.calls, 1);
  assert.equal(done.twiceRejected, true);
  assert.equal(done.cloneRejected, true);
  assert.equal(done.usable, 1);
  assert.equal((await r.run(1 - winner, "admit")).permit, false);
  assert.equal(
    (await r.run(0, "replay", 1, { id: done.job.id })).permit,
    false,
  );
  assert.equal((await r.run(0, "budget")).used, 1);
  assert.deepEqual(r.observed, ["POST synthetic"]);
});
test("workerd actual D1: lost admission and dispatch acknowledgments have zero synthetic outbound", async (t) => {
  const r = await runtime(t),
    a = await r.run(0, "lost-admit");
  assert.equal(a.status, 200, JSON.stringify(a));
  assert.equal(a.permit, false);
  assert.equal((await r.run(1, "admit")).permit, false);
  assert.equal(
    (await r.run(1, "cancel", 1, { id: a.job.id })).state,
    "cancelled",
  );
  assert.equal((await r.run(0, "budget")).used, 0);
  const b = await r.run(0, "lost-dispatch", 2);
  assert.equal(b.status, 200, JSON.stringify(b));
  assert.equal(b.permit, false);
  assert.equal(b.job.state, "running");
  assert.equal((await r.run(1, "replay", 2, { id: b.job.id })).permit, false);
  assert.equal((await r.run(0, "budget")).busy, true);
  assert.deepEqual(r.observed, []);
});
test("workerd actual D1: cancellation linearizes before receipt and late ack preserves quarantine", async (t) => {
  const r = await runtime(t),
    a = await r.run(0, "cancel-in-flight");
  assert.equal(a.status, 200, JSON.stringify(a));
  assert.equal(a.job.state, "cancelled");
  assert.equal(a.usable, 0);
  assert.equal(a.calls, 1);
  assert.equal((await r.run(1, "budget")).used, 1);
  assert.deepEqual(r.observed, ["POST synthetic"]);
});

test("workerd actual D1: delayed consume rechecks primary cancellation with zero outbound", async (t) => {
  const r = await runtime(t),
    a = await r.run(0, "delay-cancel");
  assert.equal(a.status, 409);
  assert.equal(a.error, "jobs_dispatch_revoked");
  assert.deepEqual(r.observed, []);
  assert.equal((await r.run(1, "budget")).busy, true);
  assert.equal((await r.run(1, "budget")).used, 1);
});

test("workerd actual D1: concurrent terminal callbacks create one receipt/event", async (t) => {
  const r = await runtime(t),
    a = await r.run(0, "terminal-double");
  assert.equal(a.status, 200, JSON.stringify(a));
  assert.equal(a.job.state, "completed");
  assert.equal(a.terminalDoubleRejected, true);
  assert.deepEqual(r.observed, ["POST synthetic"]);
  assert.equal(
    (
      await r.d1
        .prepare("SELECT count(*) n FROM shelf_job_call_receipts")
        .first()
    ).n,
    1,
  );
  assert.equal(
    (
      await r.d1
        .prepare(
          "SELECT count(*) n FROM shelf_job_events WHERE kind='call_finished'",
        )
        .first()
    ).n,
    1,
  );
});

test("workerd actual D1: late success past call deadline stays quarantined before job expiry", async (t) => {
  const r = await runtime(t),
    a = await r.run(0, "late-success");
  assert.equal(a.status, 200, JSON.stringify(a));
  assert.equal(a.job.state, "failed");
  assert.equal(a.usable, 0);
  const row = await r.d1
    .prepare(
      "SELECT j.deadline_at job_deadline,i.deadline_at call_deadline,r.observed_at,r.usable FROM shelf_jobs j JOIN shelf_job_call_intents i ON i.job_id=j.job_id JOIN shelf_job_call_receipts r ON r.job_id=i.job_id AND r.ordinal=i.ordinal",
    )
    .first();
  assert.ok(row.call_deadline < row.observed_at);
  assert.ok(row.job_deadline > row.observed_at);
  assert.equal(row.usable, 0);
  assert.deepEqual(r.observed, ["POST synthetic"]);
  assert.equal((await r.run(1, "replay", 1, { id: a.job.id })).permit, false);
});
