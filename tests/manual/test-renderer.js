// 在最小 DOM 桩里跑 renderer/index.mjs，验证 v4（真渲染）链路：
//  - onLoad 不抛错、背景舞台挂到 body、全局样式写入 head
//  - 载荷通道：<script src=plugin-renderer://...> 加载 → window.__PIWE_ASSET → 字节 → 真画面
//  - scene 走 WebWallGL 引擎（引擎脚本也是同一条 <script> 通道）
//  - video / image 走 Blob + <video>/<img>
//  - 载荷失败时回落到 preview 分块通道，且分块仍然串行限速
//  - onUnload 彻底清理（舞台 / 样式 / blob URL / 引擎实例）
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL, fileURLToPath } = require("node:url");

// 隔离配置目录：测试不能写到真实的 ~/.pi-wallpaper-engine。
const sandboxHome = path.join(__dirname, "sandbox-home");
fs.mkdirSync(sandboxHome, { recursive: true });
os.homedir = () => sandboxHome;

// 每次都从干净配置起步：否则上一次运行留下的 selectedId 会被带进断言，
// 也会让测试依赖「本机恰好订阅过哪张壁纸」。这里用空 id，测试本身不关心具体值。
const sandboxCfgDir = path.join(sandboxHome, ".pi-wallpaper-engine");
fs.mkdirSync(sandboxCfgDir, { recursive: true });
fs.writeFileSync(
  path.join(sandboxCfgDir, "config.json"),
  JSON.stringify({ enabled: true, selectedId: "", dim: 0.55, glass: 0.55, blur: 16, fit: "cover" }, null, 2) + "\n",
  "utf8"
);

const PLUGIN_DIR = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------- DOM 桩
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || "").toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    // 真实浏览器会把 cssText 拆成具体属性，桩里必须模拟这一点，
    // 否则读 node.style.position 之类永远是空串。
    this.style = new Proxy({ cssText: "", setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }, {
      get: (t, k) => (k in t ? t[k] : ""),
      set: (t, k, v) => {
        if (k === "cssText") {
          t.cssText = v;
          for (const part of String(v).split(";")) {
            const i = part.indexOf(":");
            if (i <= 0) continue;
            const key = part.slice(0, i).trim();
            const val = part.slice(i + 1).trim();
            if (!key) continue;
            // "z-index" -> zIndex，其它常见的短横线属性同理，够桩用。
            const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            t[camel] = val;
          }
          return true;
        }
        t[k] = v;
        return true;
      },
    });
    this.dataset = {};
    this.attributes = {};
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
      toggle: (c, on) => (on ? this.classList._set.add(c) : this.classList._set.delete(c)),
    };
    this.listeners = {};
    this.textContent = "";
    this.className = "";
    this._id = "";
    this.src = "";
    this.isConnected = false;
  }
  get id() { return this._id; }
  set id(v) { this._id = v; if (v) registry.set(v, this); }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    this.childNodes.push(node);
    node.parentNode = this;
    markConnected(node);
    // <script> 必须在挂进文档后才开始加载。
    if (node.tagName === "SCRIPT") scheduleScript(node);
    return node;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    if (idx < 0) this.childNodes.push(node); else this.childNodes.splice(idx, 0, node);
    node.parentNode = this;
    markConnected(node);
    if (node.tagName === "SCRIPT") scheduleScript(node);
    return node;
  }
  removeChild(node) {
    const idx = this.childNodes.indexOf(node);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    node.parentNode = null;
    markDisconnected(node);
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === "src") this.src = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const arr = this.listeners[type] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatch(type, ev) {
    for (const fn of (this.listeners[type] || []).slice()) {
      try { fn(ev || { type }); } catch (e) { console.error("listener threw:", e.message); }
    }
  }
  decode() { return Promise.resolve(); }
}

class FakeVideo extends FakeNode {
  constructor() { super("video"); this.paused = false; this.currentTime = 0; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}
class FakeImage extends FakeNode {
  constructor() { super("img"); this.complete = true; this.naturalWidth = 3840; this.naturalHeight = 2160; }
}

/** 递归收集节点文本：列表条目的文字挂在子节点上，不能只看自身 textContent。 */
function textOf(node) {
  if (!node) return "";
  const own = node.textContent || "";
  const kids = (node.childNodes || []).map(textOf).join(" ");
  return `${own} ${kids}`.trim();
}

const registry = new Map();
function markConnected(n) {
  n.isConnected = true;
  for (const c of n.childNodes) markConnected(c);
}
function markDisconnected(n) {
  n.isConnected = false;
  for (const c of n.childNodes) markDisconnected(c);
}

const documentStub = {
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  documentElement: new FakeNode("html"),
  createElement: (tag) => {
    const t = String(tag).toLowerCase();
    if (t === "video") return new FakeVideo();
    if (t === "img") return new FakeImage();
    return new FakeNode(t);
  },
  // 遮挡降级要读 document.hidden：默认可见，测试里可以随时改写。
  hidden: false,
  getElementById: (id) => {
    const node = registry.get(id);
    return node && node.isConnected ? node : null;
  },
};
// document 本身要能收发事件：遮挡降级监听的是 document 的 visibilitychange。
documentStub.listeners = {};
documentStub.addEventListener = FakeNode.prototype.addEventListener;
documentStub.removeEventListener = FakeNode.prototype.removeEventListener;
documentStub.dispatch = FakeNode.prototype.dispatch;
documentStub.documentElement.appendChild(documentStub.body);
documentStub.documentElement.appendChild(documentStub.head);

// ---------------------------------------------------------------- 脚本通道桩
// 真实环境里 <script src="plugin-renderer://..."> 由 Chromium 读取插件目录。
// 这里把 URL 还原成磁盘路径，用 eval 还原「脚本执行后挂全局变量」的语义。
const scriptLog = [];
/** 置 true 时，下一个载荷脚本模拟加载失败，用于验证回落路径。 */
let failNextPayload = false;
const enginePath = path.join(PLUGIN_DIR, "vendor", "webwallgl.global.min.js");

/** WebWallGL 桩：只提供渲染端用到的那几个 API，并记录调用。 */
const engineLog = { created: [], loaded: [], destroyed: 0, fit: [], fps: [] };
/** 遮挡降级用：统计引擎被暂停/恢复的次数。 */
let pausedCalls = 0;
let resumeCalls = 0;
function makeEngineStub() {
  return {
    createScene(host, opts) {
      engineLog.created.push({ host, opts });
      engineLog.fps.push(opts && opts.fps);
      engineLog.fit.push(opts && opts.fit);
      const inst = {
        canvas: new FakeNode("canvas"),
        stats: { fps: 30 },
        handlers: {},
        on(type, fn) { this.handlers[type] = fn; },
        async load(source) {
          // 校验真的拿到了字节，而不是空壳。
          const n = source && source.bytes ? source.bytes.length : 0;
          if (!n) throw new Error("引擎收到的字节为空");
          engineLog.loaded.push(n);
          return { ok: true };
        },
        pause() { pausedCalls += 1; }, resume() { resumeCalls += 1; },
        setFit(v) { engineLog.fit.push(v); },
        setFps(v) { engineLog.fps.push(v); },
        setQuality() {}, setRenderDpr() {}, setVolume() {},
        destroy() { engineLog.destroyed += 1; },
      };
      return inst;
    },
    bytesSource(bytes) { return { bytes }; },
    httpSource(url) { return { url }; },
    fileSource(file) { return { file }; },
    createMediaSource() { return {}; },
  };
}

function scheduleScript(node) {
  const url = String(node.src || "");
  scriptLog.push(url);
  setTimeout(() => {
    try {
      // 载荷 URL 会带 ?v=... 防缓存参数，先剥掉查询串再还原成磁盘路径。
      const parsed = url.startsWith("file:") ? new RealURL(url) : null;
      const disk = parsed ? fileURLToPath(`${parsed.protocol}//${parsed.host}${parsed.pathname}`) : "";
      if (!disk) throw new Error(`桩不支持这种 URL：${url}`);
      if (!fs.existsSync(disk)) throw new Error(`文件不存在：${disk}`);
      const text = fs.readFileSync(disk, "utf8");

      const isPayload = /[\\/]payload[\\/]/.test(disk);
      if (isPayload && failNextPayload) {
        failNextPayload = false;
        node.dispatch("error");
        return;
      }

      if (path.resolve(disk) === path.resolve(enginePath)) {
        globalThis.WebWallGL = makeEngineStub();
      } else {
        // 载荷脚本只有一句 window.__PIWE_ASSET = {...};
        // 用 new Function 执行以保持「真的跑脚本」的语义（包括语法错误）。
        // eslint-disable-next-line no-new-func
        new Function("window", text)(globalThis);
      }
      node.dispatch("load");
    } catch (error) {
      console.error("script stub:", error.message);
      node.dispatch("error");
    }
  }, 0);
}

globalThis.document = documentStub;
globalThis.window = globalThis;
// window 就是 globalThis：遮挡降级监听 blur/focus，桩要能收也能派发。
globalThis.windowListeners = {};
globalThis.addEventListener = function (type, fn) {
  (globalThis.windowListeners[type] = globalThis.windowListeners[type] || []).push(fn);
};
globalThis.removeEventListener = function (type, fn) {
  const arr = globalThis.windowListeners[type] || [];
  const i = arr.indexOf(fn);
  if (i >= 0) arr.splice(i, 1);
};
globalThis.dispatch = function (type, ev) {
  for (const fn of (globalThis.windowListeners[type] || []).slice()) {
    try { fn(ev || { type }); } catch (e) { console.error("listener threw:", e.message); }
  }
};
globalThis.HTMLVideoElement = FakeVideo;
globalThis.HTMLImageElement = FakeImage;
globalThis.HTMLElement = FakeNode;
globalThis.setTimeout = setTimeout;

// URL 桩：保留真实的 URL 解析（renderer 要用 new URL(rel, import.meta.url)），
// 只把 createObjectURL/revokeObjectURL 换成可追踪版本。
const liveUrls = new Map();
const RealURL = globalThis.URL;
class UrlStub extends RealURL {
  static createObjectURL(blob) {
    const u = `blob:fake/${liveUrls.size + 1}:${blob.size}`;
    liveUrls.set(u, blob);
    return u;
  }
  static revokeObjectURL(u) { liveUrls.delete(u); }
}
globalThis.URL = UrlStub;

globalThis.Blob = class Blob {
  constructor(parts, opts) {
    this.parts = parts;
    this.type = (opts && opts.type) || "";
    this.size = parts.reduce((n, p) => n + (p.byteLength !== undefined ? p.byteLength : p.length || 0), 0);
  }
};
globalThis.atob = (b64) => Buffer.from(b64, "base64").toString("binary");

// ---------------------------------------------------------------- pi 桩
const rpcLog = [];
let pluginMain = null;
const pi = {
  plugin: { id: "local.wallpaper-engine", version: "1.0.0" },
  ui: {
    injectStyle: (css) => { injected.add(css); return () => { injected.delete(css); }; },
    openLayer: () => {
      const node = new FakeNode("div");
      node.setAttribute("data-pi-plugin", "local.wallpaper-engine");
      documentStub.body.appendChild(node);
      layers.push(node);
      return { element: node, close: () => { if (node.parentNode) node.parentNode.removeChild(node); } };
    },
    showToast: async () => {},
  },
  slots: { register: () => () => {} },
  dispatch: async (action, payload) => {
    if (action !== "plugin.call") throw new Error(`unexpected action ${action}`);
    rpcLog.push({ method: payload.method, args: payload.args, at: Date.now() });
    return pluginMain.onRendererCall(payload.method, payload.args || {});
  },
};
const injected = new Set();
const layers = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findStage() {
  return documentStub.body.childNodes.find((n) => n.id === "piwe-stage");
}
function findPanel() {
  return documentStub.body.childNodes
    .flatMap((n) => n.childNodes)
    .find((n) => n.className === "piwe-panel");
}
function findTrigger() {
  return layers.map((l) => l.childNodes.find((n) => n.className === "piwe-trigger")).find(Boolean);
}
function listItems() {
  const panel = findPanel();
  const list = panel && panel._refs && panel._refs.list;
  return list ? list.childNodes.filter((n) => n.className === "piwe-item") : [];
}
/** 舞台里的真画面节点：liveBox 的子节点。 */
function liveChildren() {
  const stage = findStage();
  if (!stage) return [];
  const box = stage.childNodes.find((n) => n.dataset && n.dataset.role === "live");
  return box ? box.childNodes : [];
}
function report(title, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${title}${extra ? `  (${extra})` : ""}`);
  return ok;
}

let failures = 0;
function check(title, ok, extra) {
  if (!report(title, ok, extra)) failures += 1;
  return ok;
}

(async () => {
  pluginMain = require(path.join(PLUGIN_DIR, "main.js"));
  await pluginMain.onLoad();

  const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, "renderer", "index.mjs")).href);
  console.log("exports:", Object.keys(mod).join(","));

  await mod.onLoad(pi);
  console.log("onLoad ok\n");

  // --- 舞台与主题样式 ------------------------------------------------------
  const stage = findStage();
  check("舞台挂在 body 上且是第一个子节点", Boolean(stage) && documentStub.body.childNodes[0] === stage);
  check("舞台 fixed + z-index:-1", stage && stage.style.position === "fixed" && stage.style.zIndex === "-1",
    stage ? `${stage.style.position}/${stage.style.zIndex}` : "无");
  const themeStyle = documentStub.head.childNodes.find((n) => n.id === "piwe-theme-style");
  check("全局样式自建在 head 上", Boolean(themeStyle));
  const css = themeStyle ? themeStyle.textContent : "";
  check("全局样式没有覆盖 --ds-bg-primary", !css.includes("--ds-bg-primary:"));
  check("侧栏玻璃规则存在", css.includes(".sidebar-surface") || css.includes("sidebar"));

  await sleep(800); // 等后台扫描

  // --- 面板 ---------------------------------------------------------------
  const trigger = findTrigger();
  check("浮动触发按钮存在", Boolean(trigger), trigger && trigger.textContent);
  trigger.dispatch("click");
  await sleep(900);
  const panel = findPanel();
  check("面板能打开", Boolean(panel));
  const items = listItems();
  check("列出真机壁纸", items.length === 5, `${items.length} 项`);
  for (const it of items) {
    console.log("   ", textOf(it));
  }

  // --- scene 真渲染（第一条通常是 scene） ---------------------------------
  const sceneIdx = items.findIndex((it) => textOf(it).includes("动态渲染"));
  check("列表里能识别出 scene 动态渲染项", sceneIdx >= 0);
  engineLog.created.length = 0;
  engineLog.loaded.length = 0;
  rpcLog.length = 0;
  const tScene = Date.now();
  items[sceneIdx].dispatch("click");
  await sleep(4000);
  const sceneMs = Date.now() - tScene;

  check("走了 Engine 真渲染", engineLog.created.length === 1, `createScene ${engineLog.created.length} 次`);
  check("引擎收到非空字节", engineLog.loaded.length === 1 && engineLog.loaded[0] > 10 * 1024 * 1024,
    engineLog.loaded.length ? `${(engineLog.loaded[0] / 1048576).toFixed(1)}MB` : "无");
  // SCENE_FPS 定为 24：背景够用，比 30 帧省约两成 GPU。
  check("引擎帧率设为 24", engineLog.fps.includes(24), JSON.stringify(engineLog.fps));
  const sceneLive = liveChildren();
  check("舞台里出现了真画面容器", sceneLive.length === 1, `${sceneLive.length} 个`);
  check("没有走预览分块通道", rpcLog.filter((c) => c.method === "assets.chunk").length === 0,
    `chunk ${rpcLog.filter((c) => c.method === "assets.chunk").length} 次`);
  console.log(`    scene 全程耗时 ${sceneMs}ms`);

  // --- video 真播放 -------------------------------------------------------
  const videoIdx = items.findIndex((it) => textOf(it).includes("视频播放"));
  check("列表里能识别出 video 真播放项", videoIdx >= 0);
  if (videoIdx >= 0) {
    engineLog.destroyed = 0;
    items[videoIdx].dispatch("click");
    await sleep(4000);
    const nodes = liveChildren();
    const video = nodes.find((n) => n.tagName === "VIDEO");
    check("切到 video 后舞台里是 <video>", Boolean(video), nodes.map((n) => n.tagName).join(","));
    check("video 是 loop+muted+autoplay", Boolean(video) && video.loop && video.muted && video.autoplay);
    check("video 的 blob MIME 是 video/mp4",
      Boolean(video) && (liveUrls.get(video.src) || {}).type === "video/mp4",
      video ? (liveUrls.get(video.src) || {}).type : "无");
    check("切走时销毁了上一个引擎实例", engineLog.destroyed === 1, `${engineLog.destroyed} 次`);
    check("上一个 scene 容器已移除", nodes.length === 1);
  }

  // --- image 高清原图 -----------------------------------------------------
  const imageIdx = items.findIndex((it) => textOf(it).includes("高清原图"));
  check("列表里能识别出 web 高清原图项", imageIdx >= 0);
  if (imageIdx >= 0) {
    items[imageIdx].dispatch("click");
    await sleep(3000);
    const nodes = liveChildren();
    const img = nodes.find((n) => n.tagName === "IMG");
    check("切到 image 后舞台里是 <img>", Boolean(img), nodes.map((n) => n.tagName).join(","));
    check("img 的 blob MIME 是 image/jpeg",
      Boolean(img) && (liveUrls.get(img.src) || {}).type === "image/jpeg",
      img ? (liveUrls.get(img.src) || {}).type : "无");
    check("一次到位，没有走分块", rpcLog.filter((c) => c.method === "assets.chunk").length === 0);
  }

  // --- 回落路径：载荷脚本失败必须退回 preview 分块 ------------------------
  console.log("\n--- 回落路径（强制载荷失败）---");
  failNextPayload = true;
  rpcLog.length = 0;
  items[sceneIdx].dispatch("click");
  await sleep(7000);
  const chunkCalls = rpcLog.filter((c) => c.method === "assets.chunk");
  check("载荷失败后走了 preview 分块", chunkCalls.length > 1, `chunk ${chunkCalls.length} 次`);
  let minGap = Infinity;
  for (let i = 1; i < chunkCalls.length; i += 1) minGap = Math.min(minGap, chunkCalls[i].at - chunkCalls[i - 1].at);
  check("分块仍然串行限速（间隔 >= 120ms）", chunkCalls.length > 1 ? minGap >= 120 : false,
    chunkCalls.length > 1 ? `最小间隔 ${minGap}ms` : "n/a");
  // 预览图在 dataset.role="preview" 那一层，不在 liveBox 里。
  const stageForPreview = findStage();
  const previewImg = stageForPreview && stageForPreview.childNodes.find((n) => n.dataset && n.dataset.role === "preview");
  check("回落时预览图被点亮", Boolean(previewImg) && previewImg.style.opacity === "1",
    previewImg ? `opacity=${previewImg.style.opacity}` : "无");

  // --- 关闭开关再打开 -----------------------------------------------------
  console.log("\n--- 关闭 / 重新开启 ---");
  panel._refs.enableInput.checked = false;
  panel._refs.enableInput.dispatch("change");
  await sleep(600);
  check("关闭后舞台被移除", !findStage());
  check("关闭后全局样式被撤销", !documentStub.getElementById("piwe-theme-style"));
  check("关闭后 blob URL 全部释放", liveUrls.size === 0, `剩 ${liveUrls.size}`);
  check("关闭后引擎实例被销毁", engineLog.destroyed >= 1, `${engineLog.destroyed} 次`);

  panel._refs.enableInput.checked = true;
  panel._refs.enableInput.dispatch("change");
  await sleep(4000);
  check("重新开启后舞台恢复", Boolean(findStage()));

  // --- 遮挡降级：最小化停画 / 失焦降帧 -------------------------------------
  console.log("\n--- 遮挡降级 ---");
  // 先回到 scene 壁纸，且确保有活的引擎实例。
  items[sceneIdx].dispatch("click");
  await sleep(4000);
  const occlInst = engineLog.created.length ? engineLog.created[engineLog.created.length - 1] : null;
  check("遮挡测试前正跑着 scene", Boolean(occlInst));

  // document.hidden = true（最小化）：必须 pause，fps 不该被改高。
  documentStub.hidden = true;
  documentStub.dispatch("visibilitychange");
  await sleep(400);
  check("最小化后引擎被暂停", pausedCalls > 0, `pause ${pausedCalls} 次`);

  // 还原可见 + 失焦：应恢复渲染但降到 OCCLUDED_FPS。
  documentStub.hidden = false;
  documentStub.dispatch("visibilitychange");
  window.dispatch("blur");
  await sleep(400);
  const fpsAfterBlur = engineLog.fps[engineLog.fps.length - 1];
  check("失焦后降帧到 6", fpsAfterBlur === 6, String(fpsAfterBlur));
  check("失焦后引擎重新在跑", resumeCalls > 0, `resume ${resumeCalls} 次`);

  // 重新聚焦：回到 24 帧。
  window.dispatch("focus");
  await sleep(400);
  const fpsAfterFocus = engineLog.fps[engineLog.fps.length - 1];
  check("重新聚焦后回到 24 帧", fpsAfterFocus === 24, String(fpsAfterFocus));

  // --- 卸载 ---------------------------------------------------------------
  mod.onUnload();
  await sleep(400);
  console.log("\n--- after onUnload ---");
  check("舞台已移除", !findStage());
  check("全局样式已移除", !documentStub.getElementById("piwe-theme-style"));
  check("注入的面板样式已撤销", injected.size === 0, `剩 ${injected.size}`);
  check("blob URL 已释放", liveUrls.size === 0, `剩 ${liveUrls.size}`);
  check("layer 已关闭", layers.filter((l) => l.isConnected).length === 0);

  await pluginMain.onUnload();

  // 测试会真的生成 54MB 载荷，收尾必须清掉。
  const payloadDir = path.join(PLUGIN_DIR, "payload");
  if (fs.existsSync(payloadDir)) {
    for (const name of fs.readdirSync(payloadDir)) {
      try { fs.unlinkSync(path.join(payloadDir, name)); } catch {}
    }
    try { fs.rmdirSync(payloadDir); } catch {}
  }
  check("测试载荷已清理", !fs.existsSync(payloadDir));

  console.log(`\n${failures === 0 ? "RENDERER_TEST_OK" : `RENDERER_TEST_FAILED (${failures} 项)`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e && e.stack ? e.stack : e); process.exit(1); });
