// Local real-browser fixture for the production management controller. The only
// substituted module is the Shelf API; all content and bytes are synthetic.
import { build } from "esbuild";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.SHELF_MANAGE_FIXTURE_PORT || 4402);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("SHELF_MANAGE_FIXTURE_PORT must be an unprivileged TCP port");
const result = await build({
  entryPoints: [path.join(root, "src/scripts/manage.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  plugins: [
    {
      name: "synthetic-shelf-api",
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/lib\/api$/ }, () => ({
          path: "mock-api",
          namespace: "synthetic",
        }));
        builder.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({
          loader: "js",
          contents: `
            const mode = new URLSearchParams(location.search).get("case") || "ready";
            const mock = window.__manageMock = {
              mode, calls: [], bytes: 0, descriptors: 0, trashed: false, uploadState: "", identifyBodies: [], polls: 0, identifyActive: 0, maxIdentifyActive: 0,
            };
            const canonicalId = "123e4567-e89b-42d3-a456-426614174000";
            const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
            const file = (id, reason) => ({id,format:"PDF",sizeBytes:15,status:"candidate",reason,visibility:"private",readable:true});
            const book = () => ({id:"book_fixture",title:"合成测试书",author:"合成作者",category:"测试",categoryId:"fixture",tags:[],description:"fixture",files:[file("file_confirmed","uploaded"),file("file_pending","not_uploaded")]});
            const entry = (trashed=false) => ({book:book(),metadataVersion:0,trashed,managementVersion:7,deletedAt:trashed?1:null,...(mock.uploadState?{upload:{id:"upload_fixture",state:mock.uploadState,canSubmit:false}}:{})});
            export async function api(route, body) {
              mock.calls.push({route,body});
              if (route === "/api/session") return {authenticated: mode !== "unauth"};
              if (route === "/api/manage") return {
                books:[entry(mock.trashed || mode === "restore-error")],
                upload: mode === "blocked"
                  ? {enabled:false,code:"normal_upload_unavailable",reasons:["authority_not_ready","storage_target_mismatch"],maxBytes:20000000,formats:["PDF"]}
                  : {enabled:true,code:"ready",reasons:[],maxBytes:20000000,formats:["PDF","EPUB","MOBI","AZW","AZW3"]},
                identify: mode === "identify-disabled"
                  ? {enabled:false,code:"identify_unconfigured",maxFilenameCharacters:255,model:"gpt-luna",dailyLimit:20,remaining:0,timeoutMs:60000}
                  : {enabled:true,code:"ready",maxFilenameCharacters:255,model:"gpt-luna",dailyLimit:20,remaining:20,timeoutMs:60000},
              };
              if (route === "/api/manage/identify") {
                mock.identifyBodies.push(body);
                mock.identifyActive++;
                mock.maxIdentifyActive = Math.max(mock.maxIdentifyActive,mock.identifyActive);
                try {
                if (mock.identifyActive > 1)
                  throw Object.assign(new Error("识别服务正忙"), {code:"identify_busy",status:503});
                if (mode === "identify-fail")
                  throw Object.assign(new Error("文件名识别失败"), {code:"identify_failed",status:502});
                if (mode === "identify-uncertain")
                  throw Object.assign(new Error("识别状态待核对"), {code:"identify_reconciliation_required",status:409});
                if (mode === "identify-edit") await delay(80);
                if (mode === "identify-submit") await delay(80);
                if (mode === "identify-race") await delay(body.filename === "slow.pdf" ? 120 : 10);
                const metadata = {
                  title: mode === "identify-null" ? null : mode === "identify-race" ? body.filename.replace(/\\.[^.]+$/, "") : "AI识别书目",
                  author: "AI作者", category: "AI分类",
                };
                if (mode === "identify-pending")
                  return {requestId:canonicalId,status:"pending",pollUrl:"/api/manage/identify/"+canonicalId};
                return {requestId:canonicalId,status:"completed",metadata,cached:false};
                } finally { mock.identifyActive--; }
              }
              if (route === "/api/manage/identify/"+canonicalId) {
                mock.polls++;
                return {requestId:canonicalId,status:"completed",metadata:{title:"轮询识别书目",author:"轮询作者",category:"轮询分类"},cached:false};
              }
              if (route === "/api/manage/uploads") {
                mock.descriptors++;
                if (mode === "duplicate" || (mode === "uncertain" && mock.descriptors > 1))
                  return {upload:{id:"upload_fixture",state:mode === "duplicate"?"reserved":"uncertain",canSubmit:false,bytesUrl:"/api/manage/uploads/upload_fixture/bytes"}};
                return {upload:{id:"upload_fixture",state:"reserved",canSubmit:true,bytesUrl:"/api/manage/uploads/upload_fixture/bytes"}};
              }
              if (route.endsWith("/trash")) {
                mock.trashed = true;
                return {book:book(),trashed:true,managementVersion:8,deletedAt:1};
              }
              if (route.endsWith("/restore")) {
                const error = Object.assign(new Error("management_conflict"), {code:"management_conflict"});
                throw error;
              }
              throw new Error("unexpected_mock_route");
            }
            export async function apiBinary(route, bytes) {
              mock.bytes++;
              mock.binary = {route,size:bytes.size,name:bytes.name};
              if (mode === "upload-lock") await delay(100);
              if (mode === "uncertain") {
                mock.uploadState = "uncertain";
                throw Object.assign(new Error("上传结果尚未确认"), {code:"upload_uncertain"});
              }
              return {upload:{id:"upload_fixture",state:"confirmed"},book:book()};
            }
            export const errorText = error => error instanceof Error ? error.message : String(error);
          `,
        }));
      },
    },
  ],
});
const bundle = result.outputFiles[0].text;

const frame = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>合成书库管理夹具</title>
<body data-result="running"><main id="main" class="manage-page">
  <div class="manage-access-status"><p id="manage-capability" role="status">正在核对…</p><a id="manage-login-cta" href="/account/" hidden>先登录</a></div>
  <form id="upload-form"><label>文件<input id="book-file" type="file"></label><p id="file-preview"></p><p id="identify-status" role="status"></p><p id="metadata-preview"></p><details id="metadata-editor"><summary>修改信息</summary><label>书名<input id="book-title"></label><label>作者<input id="book-author"></label><label>分类<input id="book-category"></label></details><button id="upload-submit" type="submit" disabled>登记并上传</button><span id="upload-status" role="status"></span></form>
  <p id="books-status" role="status">登录后加载私人书库。</p><span id="books-count"></span><button id="manage-reload" type="button">重新核对书库</button><div id="books-list"></div>
  <span id="trash-count"></span><p id="trash-status" role="status"></p><div id="trash-list"></div>
</main><script type="module">
  import { initManage } from "/manage.js";
  const mode = new URLSearchParams(location.search).get("case");
  const wait = async (check, label) => { for(let n=0;n<300;n++){if(check()) return; await new Promise(r=>setTimeout(r,20));} throw Error("timeout:"+label); };
  const assert = (condition, message) => { if(!condition) throw Error(message); };
  const setFile = (name="fixture.pdf") => { const transfer=new DataTransfer(); transfer.items.add(new File(["synthetic local bytes"],name,{type:name.endsWith("epub")?"application/epub+zip":"application/pdf",lastModified:1})); const input=document.getElementById("book-file"); input.files=transfer.files; input.dispatchEvent(new Event("change",{bubbles:true})); };
  const submit = () => document.getElementById("upload-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
  const clickText = (root, text) => { const button=[...root.querySelectorAll("button")].find(el=>el.textContent.trim()===text); if(!button) throw Error("missing button:"+text); button.click(); return button; };
  const status = () => document.getElementById("identify-status").textContent;
  const bodyIsFilenameOnly = body => Object.keys(body||{}).sort().join(",")==="filename,requestId" && typeof body.filename==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId);
  const mock = () => window.__manageMock;
  try {
    initManage();
    if(mode==="early-select") setFile("early.pdf");
    await wait(()=>mode==="unauth"
      ? document.getElementById("books-status").textContent.includes("需要所有者登录")
      : document.getElementById("books-status").textContent!=="登录后加载私人书库。", "initial load");
    const m=mock();
    if(mode==="unauth") {
      setFile(); submit();
      assert(!document.getElementById("manage-login-cta").hidden,"anonymous login CTA missing");
      assert(document.getElementById("upload-submit").textContent.includes("先登录"),"anonymous upload label unclear");
      assert(m.identifyBodies.length===0 && m.descriptors===0 && m.bytes===0,"anonymous request sent filename or file");
    } else if(mode==="early-select") {
      await wait(()=>m.identifyBodies.length===1 && status().includes("AI已根据文件名识别"),"selection before identify capability");
      assert(bodyIsFilenameOnly(m.identifyBodies[0]),"identify body contained fields beyond filename and requestId");
    } else if(mode==="blocked") {
      setFile();
      await wait(()=>m.identifyBodies.length===1 && status().includes("AI已根据文件名识别"),"identify while upload blocked");
      assert(document.getElementById("upload-submit").disabled && document.getElementById("upload-submit").textContent.includes("上传暂不可用"),"blocked upload state unclear");
      assert(document.getElementById("manage-capability").textContent.includes("尚未完成") && document.getElementById("manage-capability").textContent.includes("普通上传存储尚未启用"),"blocked upload reasons missing");
      assert(bodyIsFilenameOnly(m.identifyBodies[0]),"identify request contained data beyond filename and requestId");
      assert(m.descriptors===0 && m.bytes===0,"blocked upload contacted descriptor/bytes");
      assert(document.getElementById("file-preview").textContent.includes("原文件内容留在设备；文件名将用于AI识别"),"blocked preview incorrectly described filename flow");
    } else if(mode==="identify-disabled") {
      setFile();
      assert(status().includes("AI识别服务尚未配置"),"identify disabled reason missing");
      assert(m.identifyBodies.length===0,"disabled identify capability still sent request");
      assert(!document.getElementById("upload-submit").disabled,"upload was incorrectly blocked by identify capability");
    } else if(mode==="identify-pending") {
      setFile();
      await wait(()=>m.polls===1 && document.getElementById("book-title").value==="轮询识别书目","canonical ID polling");
      assert(m.identifyBodies.length===1 && bodyIsFilenameOnly(m.identifyBodies[0]),"pending identify POST was invalid or repeated");
      assert(m.calls.filter(c=>c.route.startsWith("/api/manage/identify/")).length===1,"poll path was not fixed to one canonical ID");
    } else if(mode==="identify-fail" || mode==="identify-uncertain") {
      setFile();
      await wait(()=>status().includes(mode==="identify-fail"?"AI识别未完成":"识别状态待核对"),"identify failure status");
      assert(document.getElementById("book-title").value==="fixture","filename fallback missing");
      document.getElementById("book-title").value="手工修改";
      document.getElementById("book-title").dispatchEvent(new Event("input",{bubbles:true}));
      document.getElementById("book-file").dispatchEvent(new Event("change",{bubbles:true}));
      await new Promise(r=>setTimeout(r,30));
      assert(m.identifyBodies.length===1,"failed/uncertain identify was automatically retried");
      assert(document.getElementById("book-title").value==="手工修改","fallback was not editable");
    } else if(mode==="identify-edit") {
      setFile();
      document.getElementById("book-title").value="我手改的书名";
      document.getElementById("book-title").dispatchEvent(new Event("input",{bubbles:true}));
      await wait(()=>status().includes("AI已根据文件名识别"),"identify edit race");
      assert(document.getElementById("book-title").value==="我手改的书名","AI overwrote a user edit");
      assert(document.getElementById("book-author").value==="AI作者","AI did not fill untouched fields");
    } else if(mode==="identify-submit") {
      setFile(); submit();
      assert(document.getElementById("upload-status").textContent.includes("正在识别文件名") && m.descriptors===0,"manual submit bypassed pending identification");
      await wait(()=>status().includes("AI已根据文件名识别"),"identify before upload submit");
      assert(m.descriptors===0,"upload began before explicit user action after identification");
    } else if(mode==="identify-null") {
      setFile();
      await wait(()=>status().includes("AI未提供书名"),"null AI title fallback");
      assert(document.getElementById("book-title").value==="fixture","null AI title did not use filename fallback");
    } else if(mode==="identify-race") {
      setFile("slow.pdf"); setFile("fast.epub");
      await new Promise(r=>setTimeout(r,20));
      assert(m.identifyBodies.length===1 && status().includes("等待前一本识别结束"),"second filename started concurrently instead of waiting");
      await wait(()=>status().includes("AI已根据文件名识别") && document.getElementById("book-title").value==="fast","latest selected file result");
      await new Promise(r=>setTimeout(r,150));
      assert(m.identifyBodies.length===2 && m.maxIdentifyActive===1 && document.getElementById("book-title").value==="fast","serialized latest-file result was wrong");
    } else if(mode==="ready" || mode==="upload-lock") {
      await wait(()=>document.querySelectorAll("#books-list a").length===1,"confirmed read link");
      setFile();
      await wait(()=>status().includes("AI已根据文件名识别"),"successful filename identification");
      assert(document.getElementById("book-title").value==="AI识别书目" && document.getElementById("book-author").value==="AI作者" && document.getElementById("book-category").value==="AI分类","AI metadata did not populate");
      if(mode==="upload-lock") {
        submit();
        assert(document.getElementById("book-file").disabled && document.getElementById("book-title").disabled && document.getElementById("book-author").disabled && document.getElementById("book-category").disabled,"upload did not lock inputs");
      } else submit();
      await wait(()=>m.bytes===1 && document.getElementById("upload-status").textContent==="文件已确认入库。","single upload");
      assert(m.descriptors===1 && m.bytes===1,"new upload did not send exactly once");
      assert(m.binary.size>0 && m.binary.name==="fixture.pdf","synthetic bytes missing from single PUT");
      const descriptor=m.calls.find(c=>c.route==="/api/manage/uploads");
      assert(descriptor.body.file.name==="fixture.pdf" && descriptor.body.title==="AI识别书目","descriptor did not use identified metadata");
      assert(!document.getElementById("book-file").disabled && !document.getElementById("book-title").disabled,"upload controls were not restored");
    } else if(mode==="duplicate") {
      setFile();
      await wait(()=>m.identifyBodies.length===1 && status().includes("AI已根据文件名识别"),"duplicate initial identify");
      document.getElementById("book-file").dispatchEvent(new Event("change",{bubbles:true}));
      await new Promise(r=>setTimeout(r,30));
      assert(m.identifyBodies.length===1,"same file caused a second identify request");
      submit();
      await wait(()=>m.descriptors===1 && document.getElementById("upload-status").textContent.includes("未发送文件内容"),"duplicate upload intent");
      assert(m.bytes===0,"duplicate intent resent file bytes");
    } else if(mode==="uncertain") {
      setFile();
      await wait(()=>status().includes("AI已根据文件名识别"),"uncertain upload identification");
      submit();
      await wait(()=>m.bytes===1 && document.getElementById("upload-status").textContent.includes("不会自动重试"),"unknown upload lock");
      document.getElementById("manage-reload").click();
      await wait(()=>document.getElementById("books-status").textContent==="书库状态已重新核对。","explicit refresh");
      submit();
      await wait(()=>m.descriptors===2,"duplicate intent check after refresh");
      assert(m.bytes===1,"uncertain upload retried bytes after refresh");
      assert(document.querySelector("#books-list .manage-upload-state")?.textContent.includes("不确定"),"reloaded uncertain state not visible");
    } else if(mode==="trash") {
      const current=document.querySelector("#books-list .manage-card");
      assert(document.querySelectorAll("#books-list a").length===1,"pending file exposed as reader link");
      clickText(current,"移入回收站");
      const review=current.querySelector(".manage-confirm");
      assert(review && !review.hidden && review.textContent.includes("不会释放存储空间"),"in-page trash review missing");
      clickText(review,"确认移入回收站");
      await wait(()=>m.trashed && document.querySelectorAll("#trash-list .manage-card").length===1,"trash CAS action");
      const call=m.calls.find(c=>c.route==="/api/manage/books/book_fixture/trash");
      assert(call?.body.expectedVersion===7,"trash did not send expected managementVersion");
    } else if(mode==="restore-error") {
      const card=document.querySelector("#trash-list .manage-card");
      clickText(card,"恢复到书库");
      await wait(()=>card.querySelector(".manage-card-status")?.textContent.includes("management_conflict"),"visible restore conflict");
      assert(card.querySelector(".manage-card-status").textContent.length>0,"restore error is hidden");
    }
    document.body.dataset.result="pass";
    document.getElementById("result").textContent="通过 · "+mode;
  } catch(error) {
    document.body.dataset.result="fail";
    document.getElementById("result").textContent="失败 · "+mode+" · "+error.message;
  }
</script><p id="result" role="status">运行中…</p></body></html>`;

const runner = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>书库管理真实 DOM 夹具</title><style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 20px;color:#282820}li{padding:6px}iframe{position:absolute;left:-10000px;width:900px;height:900px}</style><h1>书库管理浏览器夹具</h1><p>合成书名与本机内存文件；API 完全替换为本地 mock，没有线上请求。</p><ol id="results"></ol><iframe id="case-frame"></iframe><script type="module">
const cases=["early-select","unauth","blocked","identify-disabled","identify-pending","identify-fail","identify-uncertain","identify-edit","identify-submit","identify-null","identify-race","ready","upload-lock","duplicate","uncertain","trash","restore-error"],list=document.getElementById("results"),frame=document.getElementById("case-frame");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const name of cases){const row=document.createElement("li");row.textContent=name+"：运行中…";list.append(row);await new Promise(resolve=>{frame.onload=resolve;frame.src="/frame?case="+encodeURIComponent(name)});for(let i=0;i<400&&frame.contentDocument.body.dataset.result==="running";i++)await delay(20);const result=frame.contentDocument.body.dataset.result;row.textContent=frame.contentDocument.getElementById("result").textContent;row.dataset.result=result;if(result!=="pass")break;}
document.body.dataset.result=[...list.children].length===cases.length&&[...list.children].every(row=>row.dataset.result==="pass")?"pass":"fail";
</script></html>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1:4402");
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type":
      url.pathname === "/manage.js"
        ? "text/javascript; charset=utf-8"
        : "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(
    url.pathname === "/manage.js"
      ? bundle
      : url.pathname === "/frame"
        ? frame
        : runner,
  );
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Synthetic management real-DOM fixture: http://127.0.0.1:${port}/ — wait for body[data-result=pass].`,
  ),
);
