// Local-only real DOM acceptance: production Astro markup and controllers,
// synthetic API/PDF parser. No credentials, real file or upstream requests.
import { build } from "esbuild";
import http from "node:http";
import fs from "node:fs/promises";
const port = Number(process.env.SHELF_BOOK_FIXTURE_PORT || 4403);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("invalid fixture port");
const mockApi = `
  import { clearPrivateSession } from "${new URL("../src/lib/private-view.mjs", import.meta.url).pathname}";
  const mode = new URLSearchParams(location.search).get("case");
  const mock = window.__bookMock = {calls:[],contents:0,accesses:0,posts:0,revoked:false,resumeError:0,destroys:0};
  const delay = ms => new Promise(r=>setTimeout(r,ms));
  const file = (id,reason) => ({id,format:"PDF",sizeBytes:42,status:"candidate",reason,visibility:"private",readable:true});
  const staticId="book_7c2fb2f721c19b44";
  const book = () => ({id:mode==="wrong-book"?"other_book":mode==="static"?staticId:"new_book",title:mode==="safe-text"?"<img src=x onerror=alert(1)>":"合成私人新书",author:"合成作者",category:"合成分类",categoryId:"fixture",tags:["<script>unsafe</script>"],description:"合成简介",files:mode==="static"?[{...file("file_846e431a99441cd1","uploaded"),sizeBytes:1592797}]:[file("file_new","uploaded"),file("file_pending","not_uploaded")]});
  export async function api(route, body) {
    mock.calls.push({route,body});
    if (body!==undefined) mock.posts++;
    if(route==="/api/session") {
      if(mock.resumeError) throw Object.assign(Error("synthetic_session_failure"),{status:mock.resumeError});
      return {authenticated:!mock.revoked&&!["anonymous-private","anonymous-trash","public","public-401"].includes(mode)};
    }
    if(route==="/api/config") return {aiConfigured:["rich","late-history","public-401"].includes(mode),privateHistory:mode==="rich"||mode==="late-history",authScheme:"owner-access-key"};
    if(route==="/api/books/new_book"||mode==="static"&&route==="/api/books/"+staticId) {
      if(mode==="late-book"||mode==="switch-id") await delay(160);
      if(mode==="anonymous-private"||mode==="anonymous-trash") throw Object.assign(Error("not_found"),{status:404});
      return {book:book(),metadataVersion:3};
    }
    if(route==="/api/books/new_book/history") {
      if(mode==="late-history") await delay(160);
      return {jobs:[{id:"job_fixture",bookId:"new_book",operation:"question",status:"completed",createdAt:"2026-10-23",content:"合成私人结果"}]};
    }
    if(route==="/api/books/new_book/published") {
      if(mode==="public-401") throw Object.assign(Error("authentication_required"),{status:401});
      return {jobs:[]};
    }
    if(route==="/api/books/new_book/metadata") return {book:{...book(),...body.changes},metadataVersion:4};
    throw Error("unexpected route:"+route);
  }
  export const session=()=>api("/api/session");
  export const errorText=e=>e.message;
  export const explainCode=x=>x;
  export async function fetchFile(id,guard=()=>{}) {
    guard(); mock.accesses++;
    if(mode==="late-access") { await delay(160); guard(); }
    mock.contents++;
    return {access:{format:"PDF"},response:new Response(new Uint8Array([1,2,3]),{headers:{"content-type":"application/pdf"}})};
  }
  window.__signOut=()=>{mock.revoked=true;clearPrivateSession()};
`;
const pdfMock = `export const GlobalWorkerOptions={};export const getDocument=()=>({promise:Promise.resolve({numPages:1,getOutline:async()=>[],getPage:async()=>({getViewport:({scale})=>({width:400*scale,height:500*scale}),render:()=>({promise:Promise.resolve(),cancel(){}})})}),destroy:async()=>{window.__bookMock.destroys++;if(new URLSearchParams(location.search).get("case")==="reader-destroy-rejection")throw Error("synthetic_destroy_failure")}});`;
const result = await build({
  stdin: {
    contents:
      'export { initDynamicBook, initBook } from "./src/scripts/book.ts";export { initReader } from "./src/scripts/reader.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  define: {
    "import.meta.env.PUBLIC_SHELF_API_MODE": '"same-origin"',
    "import.meta.env.BASE_URL": '"/the-shelf/"',
  },
  plugins: [
    {
      name: "synthetic-api",
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/lib\/api$/ }, () => ({
          path: "api",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /^pdfjs-dist/ }, (args) => ({
          path: args.path,
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          loader: "js",
          resolveDir: process.cwd(),
          contents:
            args.path === "api"
              ? mockApi
              : args.path === "pdfjs-dist"
                ? pdfMock
                : 'export default "/synthetic-worker.js";',
        }));
      },
    },
  ],
});
const bundle = result.outputFiles[0].text;
const shells = await Promise.all(
  ["book", "read", "books/book_7c2fb2f721c19b44"].map(async (p) =>
    (
      await fs.readFile(
        new URL(`../dist/${p}/index.html`, import.meta.url),
        "utf8",
      )
    )
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<link\b[^>]*>/gi, "")
      .replace('data-read-base="/"', 'data-read-base="/the-shelf/"')
      .replace("data-file-mode", 'data-file-mode="same-origin"'),
  ),
);
// Keep assertion/source literals out of the inspected page DOM. The complete
// document.body privacy assertions below must inspect application DOM only.
const harness = `
import {initDynamicBook,initBook,initReader} from "/bundle.js";
const mode=new URLSearchParams(location.search).get("case"),reader=location.pathname.includes("/read/");
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(v,m)=>{if(!v)throw Error(m)};
const started=performance.now(),deadline=started+4000;
const phase=name=>{document.body.dataset.fixturePhase=name;document.body.dataset.fixtureElapsed=String(Math.round(performance.now()-started));};
const timeout=()=>Object.assign(Error("timeout at "+document.body.dataset.fixturePhase),{fixtureTimeout:true});
const bounded=async task=>{
 let timer;
 try {const value=await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeout()),Math.max(0,deadline-performance.now()));})]);if(performance.now()>=deadline)throw timeout();return value;}
 finally {clearTimeout(timer);}
};
const wait=async(test,name)=>{phase(name);const until=Math.min(deadline,performance.now()+2000);for(;;){if(performance.now()>=until)throw timeout();if(test())return;await delay(10)}};
// Register before starting the async run, then let module evaluation finish.
// Never synthesize the initial lifecycle event or make module evaluation wait
// for the load/pageshow boundary that it is itself part of.
const initialPageShown=new Promise(resolve=>{
  const shown=event=>{if(!event.isTrusted)return;window.removeEventListener("pageshow",shown);resolve();};
  window.addEventListener("pageshow",shown);
});
let unhandled=0;
window.addEventListener("unhandledrejection",()=>unhandled++);
void (async function run() {
try {
 phase("init-start");
 const task=reader?initReader():mode==="static"?initBook():initDynamicBook();
 if(mode==="late-book"||mode==="late-history"||mode==="late-access") { await delay(30);window.__signOut(); }
 if(mode==="switch-id") {await delay(30);history.replaceState(null,"","?id=other_book&case=switch-id");}
 await bounded(task);
 phase("init-done");
 phase("wait-initial-pageshow");
 await bounded(initialPageShown);
 phase("initial-pageshow-done");
 await bounded(delay(0));
 document.body.dataset.fixtureReady="true";
 phase("assertions");
 const m=window.__bookMock;
 if(mode==="invalid"||mode==="duplicate-id") assert(m.calls.length===0,"invalid query sent API request");
 else if(mode==="anonymous-private"||mode==="anonymous-trash") {assert(document.getElementById("book-content").hidden,"denied book shown");assert(!document.body.textContent.includes("合成私人新书"),"private metadata leaked");}
 else if(mode==="wrong-book"||mode==="wrong-file") {assert(m.accesses===0&&m.contents===0,"mismatched file requested content");}
 else if(mode==="late-book"||mode==="late-history"||mode==="late-access"||mode==="switch-id") {assert(!document.body.textContent.includes("合成私人"),"late response restored private DOM");assert(m.contents===0,"late access requested content");}
 else if(reader) {
   assert(document.querySelector("#reader canvas"),"PDF canvas missing");assert(document.getElementById("book-link").getAttribute("href")==="/the-shelf/book/?id=new_book","reader return did not use dynamic detail/base");
   if(mode==="reader-resume-401") {const n=m.calls.length;m.resumeError=401;window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));await wait(()=>!document.querySelector("#reader canvas"),"reader-resume-wait");assert(m.calls.length===n+1&&m.calls.at(-1).route==="/api/session"&&m.contents===1,"reader resume requested extra content");}
   else window.__signOut();
   phase("reader-cleanup");
   assert(!document.querySelector("#reader canvas")&&!document.body.textContent.includes("合成私人"),"reader logout did not clear private DOM");
   assert(m.destroys===1,"reader logout did not destroy its PDF loading task");
   if(mode==="reader-destroy-rejection") {await delay(25);assert(unhandled===0,"PDF cleanup caused an unhandled rejection");}
 }
 else {
   assert(!document.getElementById("book-content").hidden,"detail remained hidden");
   assert(document.querySelectorAll("[data-dynamic-file-action]").length===2,"pending file action exposed or confirmed file missing");
   assert(document.querySelector("[data-dynamic-file-action]").getAttribute("href")===(mode==="static"?"/the-shelf/read/?book=book_7c2fb2f721c19b44&file=file_846e431a99441cd1":"/the-shelf/read/?book=new_book&file=file_new"),"read href/base incorrect");
   if(mode==="safe-text") assert(!document.querySelector("#book-title img")&&document.getElementById("book-title").textContent.startsWith("<img"),"unsafe HTML parsed");
   if(mode==="rich") {assert(document.getElementById("history").textContent.includes("合成私人结果"),"history missing");document.getElementById("metadata-title").value="合成编辑";phase("metadata-submit");document.getElementById("metadata-form").dispatchEvent(new Event("submit",{cancelable:true}));await wait(()=>document.getElementById("book-title").textContent==="合成编辑","metadata-wait");assert(m.posts===1,"metadata did not save exactly once");}
   else assert(m.posts===0,"browsing started AI or mutation");
   assert(m.accesses===0&&m.contents===0,"browsing fetched a file");
   if(["resume-session","resume-401","visibility-session"].includes(mode)) {
     const n=m.calls.length;m.revoked=true;if(mode==="resume-401")m.resumeError=401;
     if(mode==="visibility-session")document.dispatchEvent(new Event("visibilitychange"));else window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));
     await wait(()=>!document.getElementById("metadata-form"),"detail-resume-wait");assert(m.calls.length===n+1&&m.calls.at(-1).route==="/api/session","resume must only check session");
   }
   else if(mode==="network-resume"||mode==="public-401") {
     const n=m.calls.length;if(mode==="network-resume")m.resumeError=503;
     window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));await delay(25);
     assert(document.getElementById("book-title").textContent==="合成私人新书","unknown/anonymous failure erased detail");
     assert(m.calls.length===n+(mode==="network-resume"?1:0),"public/unknown resume requested unexpected data: "+JSON.stringify(m.calls.slice(n).map(call=>call.route)));
     window.__signOut();
   }
   else window.__signOut();
   phase("detail-cleanup");
   assert(!document.body.textContent.includes("合成私人")&&!document.getElementById("metadata-form"),"logout did not clear editor/history/private metadata");
 }
 if(performance.now()>=deadline)throw timeout();
 phase("done");
 document.body.dataset.result="pass";document.getElementById("result").textContent="通过 · "+mode;
} catch(error) {document.body.dataset.result=error.fixtureTimeout?"timeout":"fail";document.getElementById("result").textContent=(error.fixtureTimeout?"超时":"失败")+" · "+mode+" · "+error.message;}
})();
`;
const cases = [
  "new-id",
  "resume-session",
  "resume-401",
  "visibility-session",
  "network-resume",
  "public",
  "public-401",
  "static",
  "safe-text",
  "rich",
  "anonymous-private",
  "anonymous-trash",
  "invalid",
  "duplicate-id",
  "wrong-book",
  "wrong-file",
  "late-book",
  "late-history",
  "switch-id",
  "reader",
  "reader-resume-401",
  "reader-destroy-rejection",
  "late-access",
];
const runner = `<!doctype html><html><meta charset="utf-8"><title>动态详情真实DOM验收</title><body><h1>动态详情与阅读夹具</h1><p>仅本机合成API，无线上请求。</p><iframe id="frame" title="当前合成验收场景" style="display:block;width:900px;max-width:100%;height:900px"></iframe><ol id="results"></ol><script type="module">
const cases=${JSON.stringify(cases)},frame=document.getElementById("frame"),list=document.getElementById("results");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const diagnostic=()=>{const doc=frame.contentDocument,m=frame.contentWindow?.__bookMock;return "phase="+(doc?.body?.dataset.fixturePhase||"harness-not-started")+", readyState="+(doc?.readyState||"unavailable")+", calls="+(m?.calls.length??0)+", posts="+(m?.posts??0)+", accesses="+(m?.accesses??0)+", contents="+(m?.contents??0);};
void (async function run() {
for(const name of cases){
 const li=document.createElement("li");li.textContent=name+"：运行中";list.append(li);
 const deadline=performance.now()+4000;
 const timedOut=phase=>Object.assign(Error("timeout at "+phase),{fixtureTimeout:true});
 let parentPhase="load",timer;
 try {
  const reader=["wrong-book","wrong-file","reader","reader-resume-401","reader-destroy-rejection","late-access"].includes(name);
  const q=reader?"book=new_book&file="+(name==="wrong-file"?"other_file":"file_new"):name==="invalid"?"id=..%2Fbad":name==="duplicate-id"?"id=new_book&id=new_book":"id=new_book";
  await new Promise((resolve,reject)=>{
   frame.onload=()=>{if(new URL(frame.contentWindow.location.href).searchParams.get("case")!==name)return;clearTimeout(timer);resolve();};
   frame.onerror=()=>reject(Error("iframe load failed"));
   timer=setTimeout(()=>reject(timedOut(parentPhase)),Math.max(0,deadline-performance.now()));
   frame.src="/the-shelf/"+(reader?"read/":name==="static"?"books/book_7c2fb2f721c19b44/":"book/")+"?"+q+"&case="+name;
  });
  parentPhase="result";
  for(;;){if(performance.now()>=deadline)throw timedOut(parentPhase);if(frame.contentDocument?.body?.dataset.result)break;await delay(10);}
  li.dataset.result=frame.contentDocument.body.dataset.result;
  li.textContent=frame.contentDocument.getElementById("result").textContent+" · "+diagnostic();
 } catch(error) {
  li.dataset.result=error.fixtureTimeout?"timeout":"fail";
  li.textContent=name+"："+(error.fixtureTimeout?"超时":"失败")+" · "+error.message+" · "+diagnostic();
 } finally {clearTimeout(timer);frame.onload=null;frame.onerror=null;}
 if(li.dataset.result!=="pass")break;
}
document.body.dataset.result=list.children.length===cases.length&&[...list.children].every(li=>li.dataset.result==="pass")?"pass":"fail";
})();
</script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === "/bundle.js" || url.pathname === "/harness.js") {
    res.writeHead(200, {
      "Content-Type": "text/javascript",
      "Cache-Control": "no-store",
    });
    res.end(url.pathname === "/bundle.js" ? bundle : harness);
    return;
  }
  let page = runner;
  if (
    url.pathname.includes("/book/") ||
    url.pathname.includes("/read/") ||
    url.pathname.includes("/books/")
  ) {
    page =
      (url.pathname.includes("/read/")
        ? shells[1]
        : url.pathname.includes("/books/")
          ? shells[2]
          : shells[0]) +
      `<p id="result">运行中</p>` +
      '<script type="module" src="/harness.js"></script>';
  }
  res.writeHead(200, {
    "Content-Type": "text/html;charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(page);
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Synthetic book/reader real DOM fixture: http://127.0.0.1:${port}/ — body[data-result=pass]`,
  ),
);
