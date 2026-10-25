#!/usr/bin/env node
// Builds dist/: the dashboard as a static site over the demo snapshot, for any static host.
// The page's API calls resolve to bundled JSON, and a small shim in the page does what the
// demo server does: shift activity timestamps to the viewer's present and report replay
// refresh as disabled.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATETIME, EXPERIMENT_ID, rebase } from "../dashboard/demo-source.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const VIEWS = ["research", "trading", "replay"];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "api", "dashboard"), { recursive: true });
for (const view of VIEWS) {
  cpSync(join(ROOT, "demo-data", "api", `${view}.json`), join(DIST, "api", "dashboard", `${view}.json`));
}

const shim = `<script>
(()=>{const DATETIME=${DATETIME},EXPERIMENT_ID=${EXPERIMENT_ID},rebase=${rebase.toString()};
const realFetch=window.fetch.bind(window),api=/\\/api\\/dashboard\\/(research|trading|replay)$/;
const json=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
window.fetch=async(input,options)=>{const path=new URL(String(input),location.href).pathname;
 if(/\\/api\\/dashboard\\/refresh(-status)?$/.test(path))return json({state:'disabled',leader:null});
 const view=api.exec(path);if(!view)return realFetch(input,options);
 const response=await realFetch(path+'.json',{signal:options?.signal});if(!response.ok)return response;
 const {generated_at,...body}=await response.json(),offset=Date.now()-Date.parse(generated_at);
 return json(Number.isFinite(offset)?rebase(body,offset):body)}})();
</script>`;
const html = readFileSync(join(ROOT, "dashboard", "index.html"), "utf8")
  .replaceAll("'__AUTOBOT_BASE_PATH__'", JSON.stringify(""))
  .replace("<script>", `${shim}\n<script>`);
writeFileSync(join(DIST, "index.html"), html);
console.log(`built ${DIST}`);
