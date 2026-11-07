// 最小复现：确认 <script> 桩能否把 window.__PIWE_ASSET 挂上。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_DIR = path.resolve(__dirname, "..", "..");
globalThis.pi = {
  commands: { register: async () => {}, unregister: async () => {} },
  ui: { showToast: async () => {} },
  plugin: { getSettings: async () => ({}) },
};
const plugin = require(path.join(PLUGIN_DIR, "main.js"));

(async () => {
  await plugin.onLoad();
  const list = await plugin.onRendererCall("library.list", {});
  const pick = list.wallpapers.find((w) => w.liveKind === "image") || list.wallpapers[0];
  const info = await plugin.onRendererCall("assets.payload", { id: pick.id });
  console.log("payload info:", JSON.stringify(info));
  const file = path.join(PLUGIN_DIR, info.rel.split("/").join(path.sep));
  const text = fs.readFileSync(file, "utf8");
  console.log("fileBytes:", text.length);
  console.log("head:", JSON.stringify(text.slice(0, 120)));
  console.log("tail:", JSON.stringify(text.slice(-20)));
  // 关键：真的执行一遍，看会不会挂全局。
  globalThis.window = globalThis;
  try {
    new Function("window", text)(globalThis);
  } catch (e) {
    console.log("EVAL FAILED:", e.message);
  }
  const pack = globalThis.__PIWE_ASSET;
  console.log("pack:", pack ? `id=${pack.id} kind=${pack.kind} b64len=${pack.b64.length}` : "NULL");
  await plugin.onUnload();
})().catch((e) => { console.error(e); process.exit(1); });
