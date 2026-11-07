// 用假 pi 加载插件主进程，验证扫描 / 分块 RPC 是否真的能读到本机壁纸。
"use strict";
const path = require("node:path");

const calls = [];
globalThis.pi = {
  commands: {
    register: async (cmd) => calls.push(["register", cmd.id]),
    unregister: async (id) => calls.push(["unregister", id]),
  },
  ui: { showToast: async (m) => calls.push(["toast", m]) },
  plugin: { getSettings: async () => ({}) },
  agent: { registerTool: async () => {} },
};

const PLUGIN_DIR = path.resolve(__dirname, "..", "..");
const plugin = require(path.join(PLUGIN_DIR, "main.js"));

(async () => {
  await plugin.onLoad();
  console.log("onLoad ok, commands:", JSON.stringify(calls));

  const list = await plugin.onRendererCall("library.list", {});
  console.log("ok:", list.ok, "total:", list.total, "truncated:", list.truncated);
  console.log("roots:", JSON.stringify(list.roots));
  for (const w of list.wallpapers) {
    console.log(`  - id=${w.id} type=${w.type} ${w.width}x${w.height} hd=${w.isHd} size=${w.size} asset=${w.assetName} preview=${w.previewName} title=${w.title}`);
  }

  if (!list.wallpapers.length) {
    console.log("NO WALLPAPERS FOUND");
    return;
  }

  // 验证 assets.meta + 分块拼起来字节数与 meta.size 一致。
  const first = list.wallpapers[0];
  const meta = await plugin.onRendererCall("assets.meta", { id: first.id });
  console.log("meta:", JSON.stringify(meta));

  const parts = [];
  let offset = 0;
  let n = 0;
  for (;;) {
    const chunk = await plugin.onRendererCall("assets.chunk", { id: first.id, offset });
    if (!chunk.ok) { console.log("chunk error:", JSON.stringify(chunk)); break; }
    parts.push(Buffer.from(chunk.b64, "base64"));
    offset = chunk.next;
    n += 1;
    if (chunk.eof) break;
    if (n > 400) { console.log("guard hit"); break; }
  }
  const total = Buffer.concat(parts);
  console.log(`chunks=${n} bytes=${total.length} meta.size=${meta.size} match=${total.length === meta.size}`);

  // 校验文件头，确认是真实的图片字节（GIF87a/GIF89a/JPEG/PNG）。
  console.log("magic:", JSON.stringify(total.subarray(0, 8).toString("latin1")));

  // 越权校验：不存在的 id 必须被拒绝。
  console.log("unknown id ->", JSON.stringify(await plugin.onRendererCall("assets.meta", { id: "does-not-exist" })));
  console.log("unknown method ->", JSON.stringify(await plugin.onRendererCall("nope", {})));
  console.log("bad offset ->", JSON.stringify(await plugin.onRendererCall("assets.chunk", { id: first.id, offset: 9e9 })));

  await plugin.onUnload();
  console.log("onUnload ok");
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
