// 关键风险实测：宿主对 renderer -> 主进程的调用有 2 秒硬超时
// （RENDERER_CALL_TIMEOUT_MS = 2e3，见 out/main/chunks 里的 RendererCallRelay）。
// 首次生成载荷要同步 readFileSync + base64 编码 + writeSync，
// 一旦总耗时越过 2 秒，渲染端那次 plugin.call("assets.payload") 会直接超时失败，
// 用户看到的就是「真画面不可用」。
//
// 本脚本删掉载荷后逐个重建，测出每个壁纸的单次耗时，判断是否安全。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_DIR = path.resolve(__dirname, "..", "..");
const PAYLOAD_DIR = path.join(PLUGIN_DIR, "payload");
const TIMEOUT_MS = 2000;

globalThis.pi = {
  commands: { register: async () => {}, unregister: async () => {} },
  ui: { showToast: async () => {} },
  plugin: { getSettings: async () => ({}) },
  agent: { registerTool: async () => {} },
};

const plugin = require(path.join(PLUGIN_DIR, "main.js"));

(async () => {
  await plugin.onLoad();
  const list = await plugin.onRendererCall("library.list", {});

  // 先清干净，强制走「首次生成」路径，这是最坏情况。
  if (fs.existsSync(PAYLOAD_DIR)) {
    for (const name of fs.readdirSync(PAYLOAD_DIR)) {
      try { fs.unlinkSync(path.join(PAYLOAD_DIR, name)); } catch {}
    }
  }

  let worst = 0;
  let worstId = "";
  const rows = [];

  for (const item of list.wallpapers) {
    if (!item.liveKind) continue;
    const t0 = process.hrtime.bigint();
    const info = await plugin.onRendererCall("assets.payload", { id: item.id });
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    if (!info.ok) {
      console.log(`[${item.id}] FAILED ${info.error}`);
      continue;
    }
    rows.push({ id: item.id, kind: info.kind, raw: info.bytes, file: info.name, ms });
    console.log(`[${item.id}] kind=${info.kind} raw=${(info.bytes / 1048576).toFixed(1)}MB ms=${ms.toFixed(0)} created=${info.created} ${ms > TIMEOUT_MS ? "*** 超时风险 ***" : "安全"}`);
    if (ms > worst) { worst = ms; worstId = item.id; }
    // 删掉再建一次没有意义（第二次是复用），这里保留文件供下面的复用计时。
  }

  // 复用路径的耗时（命中大小校验就返回，应该极快）。
  console.log("\n--- 复用路径 ---");
  for (const item of list.wallpapers) {
    if (!item.liveKind) continue;
    const t0 = process.hrtime.bigint();
    const info = await plugin.onRendererCall("assets.payload", { id: item.id });
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    console.log(`[${item.id}] ms=${ms.toFixed(0)} created=${info.created} ${ms > TIMEOUT_MS ? "*** 超时风险 ***" : "安全"}`);
  }

  console.log(`\n最慢首次生成：${worstId} ${worst.toFixed(0)}ms（宿主超时 ${TIMEOUT_MS}ms）`);
  console.log(worst > TIMEOUT_MS ? "结论：会超时，必须改方案" : "结论：全部在超时线内");

  // 收拾干净，别把几百 MB 留在插件目录里。
  const clean = await plugin.onRendererCall("assets.cleanup", {});
  console.log("cleanup ->", JSON.stringify(clean));
  for (const name of fs.existsSync(PAYLOAD_DIR) ? fs.readdirSync(PAYLOAD_DIR) : []) {
    console.log("  仍存在:", name);
  }
  await plugin.onUnload();
})().catch((e) => { console.error("FAILED:", e && e.stack ? e.stack : e); process.exit(1); });
