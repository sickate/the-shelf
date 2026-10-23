// Local real-browser fixture for the production management controller. The only
// substituted module is the Shelf API; all content and bytes are synthetic.
import { build } from "esbuild";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
              mode, calls: [], bytes: 0, descriptors: 0, trashed: false, uploadState: "",
            };
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
                  : {enabled:true,code:"ready",reasons:[],maxBytes:20000000,formats:["PDF"]},
              };
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
  <p id="manage-capability" role="status">正在核对…</p>
  <form id="upload-form"><label>书名<input id="book-title" required value="合成测试书"></label><label>作者<input id="book-author" value="合成作者"></label><label>分类<input id="book-category" value="测试"></label><label>文件<input id="book-file" type="file" required></label><p id="file-preview"></p><button id="upload-submit" type="submit" disabled>登记并上传</button><span id="upload-status" role="status"></span></form>
  <p id="books-status" role="status">登录后加载私人书库。</p><span id="books-count"></span><button id="manage-reload" type="button">重新核对书库</button><div id="books-list"></div>
  <span id="trash-count"></span><p id="trash-status" role="status"></p><div id="trash-list"></div>
</main><script type="module">
  import { initManage } from "/manage.js";
  initManage();
  const wait = async (check, label) => { for(let n=0;n<100;n++){if(check()) return; await new Promise(r=>setTimeout(r,20));} throw Error("timeout:"+label); };
  const assert = (condition, message) => { if(!condition) throw Error(message); };
  const setFile = () => { const transfer=new DataTransfer(); transfer.items.add(new File(["synthetic local bytes"],"fixture.pdf",{type:"application/pdf"})); const input=document.getElementById("book-file"); input.files=transfer.files; input.dispatchEvent(new Event("change",{bubbles:true})); };
  const submit = () => document.getElementById("upload-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
  const clickText = (root, text) => { const button=[...root.querySelectorAll("button")].find(el=>el.textContent.trim()===text); if(!button) throw Error("missing button:"+text); button.click(); return button; };
  const mode = new URLSearchParams(location.search).get("case");
  try {
    await wait(()=>mode==="unauth"
      ? document.getElementById("books-status").textContent.includes("需要所有者登录")
      : document.getElementById("books-status").textContent!=="登录后加载私人书库。", "initial load");
    const mock=window.__manageMock;
    if(mode==="unauth") {
      setFile(); submit();
      assert(mock.calls.filter(c=>c.route==="/api/manage").length===0,"unauth loaded private list");
      assert(mock.bytes===0 && mock.descriptors===0,"unauth transmitted file");
    } else if(mode==="blocked") {
      setFile(); submit();
      assert(document.getElementById("upload-submit").disabled,"blocked upload button enabled");
      const blockedMessage = document.getElementById("manage-capability").textContent;
      assert(blockedMessage.includes("尚未完成") && blockedMessage.includes("普通上传存储尚未启用"),"blocked reason missing");
      assert(mock.descriptors===0 && mock.bytes===0,"blocked upload contacted descriptor/bytes");
    } else if(mode==="ready") {
      await wait(()=>document.querySelectorAll("#books-list a").length===1,"confirmed read link");
      assert(document.querySelector("#books-list a").href.includes("file_confirmed"),"read link is not the confirmed file");
      setFile(); submit();
      await wait(()=>mock.bytes===1 && document.getElementById("upload-status").textContent==="文件已确认入库。","single upload");
      assert(mock.descriptors===1 && mock.bytes===1,"new upload did not send exactly once");
      assert(mock.binary.size>0 && mock.binary.name==="fixture.pdf","synthetic bytes missing from single PUT");
      const pending=mock.calls.find(c=>c.route==="/api/manage/uploads");
      assert(pending.body.file.name==="fixture.pdf" && pending.body.title==="合成测试书","descriptor values missing");
    } else if(mode==="duplicate") {
      setFile(); submit();
      await wait(()=>mock.descriptors===1,"duplicate descriptor");
      await wait(()=>document.getElementById("upload-status").textContent.includes("未发送文件内容"),"duplicate intent status");
      assert(mock.bytes===0,"duplicate intent resent file bytes");
      assert(document.getElementById("upload-status").textContent.includes("未发送文件内容"),"duplicate state unclear");
    } else if(mode==="uncertain") {
      setFile(); submit();
      await wait(()=>mock.bytes===1 && document.getElementById("upload-submit").disabled && document.getElementById("upload-status").textContent.includes("不会自动重试"),"unknown upload lock");
      assert(document.getElementById("upload-status").textContent.includes("不会自动重试"),"uncertain result unclear");
      document.getElementById("manage-reload").click();
      await wait(()=>document.getElementById("books-status").textContent==="书库状态已重新核对。","explicit refresh");
      submit();
      await wait(()=>mock.descriptors===2,"duplicate intent check after refresh");
      assert(mock.bytes===1,"uncertain upload retried bytes after refresh");
      assert(document.querySelector("#books-list .manage-upload-state")?.textContent.includes("不确定"),"reloaded uncertain state not visible");
    } else if(mode==="trash") {
      const current=document.querySelector("#books-list .manage-card");
      assert(document.querySelectorAll("#books-list a").length===1,"pending file exposed as reader link");
      clickText(current,"移入回收站");
      const review=current.querySelector(".manage-confirm");
      assert(review && !review.hidden && review.textContent.includes("不会释放存储空间"),"in-page trash review missing");
      clickText(review,"确认移入回收站");
      await wait(()=>mock.trashed && document.querySelectorAll("#trash-list .manage-card").length===1,"trash CAS action");
      const call=mock.calls.find(c=>c.route==="/api/manage/books/book_fixture/trash");
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
const cases=["unauth","blocked","ready","duplicate","uncertain","trash","restore-error"],list=document.getElementById("results"),frame=document.getElementById("case-frame");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const name of cases){const row=document.createElement("li");row.textContent=name+"：运行中…";list.append(row);await new Promise(resolve=>{frame.onload=resolve;frame.src="/frame?case="+encodeURIComponent(name)});for(let i=0;i<200&&frame.contentDocument.body.dataset.result==="running";i++)await delay(20);const result=frame.contentDocument.body.dataset.result;row.textContent=frame.contentDocument.getElementById("result").textContent;row.dataset.result=result;if(result!=="pass")break;}
document.body.dataset.result=[...list.children].length===cases.length&&[...list.children].every(row=>row.dataset.result==="pass")?"pass":"fail";
</script></html>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1:4402");
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": url.pathname === "/manage.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(url.pathname === "/manage.js" ? bundle : url.pathname === "/frame" ? frame : runner);
});
server.listen(4402, "127.0.0.1", () =>
  console.log("Synthetic management real-DOM fixture: http://127.0.0.1:4402/ — wait for body[data-result=pass]."),
);
