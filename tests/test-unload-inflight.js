// 专项验证：真画面「飞行中」卸载不得泄漏（WebGL 实例 / blob URL / DOM 节点）。
//
// 覆盖两条路径：
//  1) scene：引擎 inst.load() 还没返回时就 onUnload —— 必须销毁引擎实例并移除容器。
//  2) video：payload 已解出、<video> 已建但还没播时 onUnload —— 必须 revoke blob URL。
//
// 桩与 test-renderer.js 同构（含 <script> 执行通道），但故意让引擎的 load()
// 长时间挂起，以便把 unload 插进飞行窗口。
"use strict";
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { pathToFileURL, fileURLToPath } = require("node:url");

const sandboxHome = path.join(__dirname, "sandbox-home");
fs.mkdirSync(sandboxHome, { recursive: true });
os.homedir = () => sandboxHome;

// 每次从干净配置起步，避免上次运行残留的 selectedId 影响断言，
// 也避免测试依赖「本机恰好订阅过哪张壁纸」。
const sandboxCfgDir = path.join(sandboxHome, ".pi-wallpaper-engine");
fs.mkdirSync(sandboxCfgDir, { recursive: true });
fs.writeFileSync(
  path.join(sandboxCfgDir, "config.json"),
  JSON.stringify({ enabled: true, selectedId: "", dim: 0.55, glass: 0.55, blur: 16, fit: "cover" }, null, 2) + "\n",
  "utf8"
);

const PLUGIN_DIR = path.resolve(__dirname, "..");

// ---------------------------------------------------------------- DOM 桩
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || "").toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.style = new Proxy({ cssText: "", setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }, {
      get: (t, k) => (k in t ? t[k] : ""),
      set: (t, k, v) => {
        if (k === "cssText") {
          t.cssText = v;
          for (const part of String(v).split(";")) {
            const i = part.indexOf(":");
            if (i <= 0) continue;
            const key = part.slice(0, i).trim();
            if (!key) continue;
            t[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = part.slice(i + 1).trim();
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
  dispatch(type, ev) { for (const fn of (this.listeners[type] || []).slice()) { try { fn(ev || { type }); } catch {} } }
  decode() { return Promise.resolve(); }
}
class FakeVideo extends FakeNode {
  constructor() { super("video"); this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}
class FakeImage extends FakeNode {}

const registry = new Map();
function markConnected(n) { n.isConnected = true; for (const c of n.childNodes) markConnected(c); }
function markDisconnected(n) { n.isConnected = false; for (const c of n.childNodes) markDisconnected(c); }

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
  getElementById: (id) => { const n = registry.get(id); return n && n.isConnected ? n : null; },
};
documentStub.documentElement.appendChild(documentStub.body);
documentStub.documentElement.appendChild(documentStub.head);

// ---------------------------------------------------------------- 引擎桩
// 关键：load() 会一直挂起到测试主动 release，用来制造「渲染飞行中」的窗口。
const engineLog = { created: 0, destroyed: 0, loadStarted: 0, host: null };
let releaseLoad = null;
const enginePath = path.join(PLUGIN_DIR, "vendor", "webwallgl.global.min.js");

function makeEngineStub() {
  return {
    createScene(host) {
      engineLog.created += 1;
      engineLog.host = host;
      return {
        canvas: new FakeNode("canvas"),
        stats: { fps: 30 },
        on() {},
        load() {
          engineLog.loadStarted += 1;
          return new Promise((resolve) => { releaseLoad = resolve; });
        },
        pause() {}, resume() {}, setFit() {}, setFps() {},
        setQuality() {}, setRenderDpr() {}, setVolume() {},
        destroy() { engineLog.destroyed += 1; },
      };
    },
    bytesSource(bytes) { return { bytes }; },
    httpSource(u) { return { u }; },
    fileSource(f) { return { f }; },
    createMediaSource() { return {}; },
  };
}

function scheduleScript(node) {
  const url = String(node.src || "");
  setTimeout(() => {
    try {
      const parsed = url.startsWith("file:") ? new RealURL(url) : null;
      const disk = parsed ? fileURLToPath(`${parsed.protocol}//${parsed.host}${parsed.pathname}`) : "";
      if (!disk) throw new Error(`桩不支持这种 URL：${url}`);
      if (!fs.existsSync(disk)) throw new Error(`文件不存在：${disk}`);
      const text = fs.readFileSync(disk, "utf8");
      if (path.resolve(disk) === path.resolve(enginePath)) {
        globalThis.WebWallGL = makeEngineStub();
      } else {
        new Function("window", text)(globalThis);
      }
      node.dispatch("load");
    } catch (error) {
      console.error("script stub:", error.message);
      node.dispatch("error");
    }
  }, 0);
}

// blob URL 桩：保留真实 URL 解析能力（renderer 用 new URL(rel, import.meta.url)），
// 只把 createObjectURL / revokeObjectURL 换成可追踪版本。
const RealURL = globalThis.URL;
const liveUrls = new Map();
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

globalThis.document = documentStub;
globalThis.window = globalThis;
globalThis.HTMLVideoElement = FakeVideo;
globalThis.HTMLImageElement = FakeImage;
globalThis.HTMLElement = FakeNode;

// ---------------------------------------------------------------- pi 桩
let pluginMain = null;
const rpcLog = [];
const layers = [];
const pi = {
  plugin: { id: "local.wallpaper-engine", version: "1.0.0" },
  ui: {
    injectStyle: () => () => {},
    openLayer: () => {
      const node = new FakeNode("div");
      documentStub.body.appendChild(node);
      layers.push(node);
      return { element: node, close: () => { if (node.parentNode) node.parentNode.removeChild(node); } };
    },
    showToast: async () => {},
  },
  slots: { register: () => () => {} },
  dispatch: async (action, payload) => {
    if (action !== "plugin.call") throw new Error(`unexpected action ${action}`);
    rpcLog.push(payload.method);
    return pluginMain.onRendererCall(payload.method, payload.args || {});
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findStage = () => documentStub.body.childNodes.find((n) => n.id === "piwe-stage");
function liveChildren() {
  const stage = findStage();
  if (!stage) return [];
  const box = stage.childNodes.find((n) => n.dataset && n.dataset.role === "live");
  return box ? box.childNodes : [];
}
function items() {
  const panel = documentStub.body.childNodes.flatMap((n) => n.childNodes).find((n) => n.className === "piwe-panel");
  const list = panel && panel._refs && panel._refs.list;
  return list ? list.childNodes.filter((n) => n.className === "piwe-item") : [];
}

let failures = 0;
function check(title, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${title}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures += 1;
}

(async () => {
  pluginMain = require(path.join(PLUGIN_DIR, "main.js"));
  await pluginMain.onLoad();

  const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, "renderer", "index.mjs")).href);
  await mod.onLoad(pi);
  await sleep(900);

  // 打开面板拿列表
  const trigger = layers.flatMap((l) => l.childNodes).find((n) => n.className === "piwe-trigger");
  trigger.dispatch("click");
  await sleep(900);
  const list = items();
  if (list.length < 4) throw new Error(`需要至少 4 张壁纸，实际 ${list.length}`);

  // 找到 scene / video 的下标（用类型标注定位，不依赖顺序）
  const textOf = (n) => `${n.textContent || ""} ${(n.childNodes || []).map(textOf).join(" ")}`.trim();
  const sceneIdx = list.findIndex((n) => textOf(n).includes("动态渲染"));
  const videoIdx = list.findIndex((n) => textOf(n).includes("视频播放"));
  if (sceneIdx < 0 || videoIdx < 0) throw new Error("没找到 scene / video 条目");

  // ---- 场景 1：引擎 load 挂起时卸载 -------------------------------------
  console.log("--- scene：inst.load() 挂起期间 onUnload ---");
  list[sceneIdx].dispatch("click");
  // 等到引擎真的被创建并开始 load
  const deadline = Date.now() + 30000;
  while (engineLog.loadStarted === 0 && Date.now() < deadline) await sleep(50);
  check("引擎已创建并开始 load", engineLog.loadStarted === 1, `loadStarted=${engineLog.loadStarted}`);
  check("此刻引擎尚未销毁", engineLog.destroyed === 0);
  const hostAtUnload = engineLog.host;
  const hostConnected = Boolean(hostAtUnload && hostAtUnload.isConnected);

  mod.onUnload();
  console.log("  onUnload 已调用（load 仍未返回）");
  // 放行挂起的 load，模拟「卸载之后引擎才回话」
  if (releaseLoad) releaseLoad();
  await sleep(600);

  check("卸载后引擎实例被销毁", engineLog.destroyed === 1, `destroyed=${engineLog.destroyed}`);
  check("卸载后场景容器已移除", !hostConnected || !hostAtUnload.isConnected);
  check("卸载后舞台已移除", !findStage());
  check("卸载后没有 blob URL 泄漏", liveUrls.size === 0, `剩 ${liveUrls.size}`);

  // ---- 场景 2：video 建好后卸载 -----------------------------------------
  console.log("\n--- video：已显示后 onUnload ---");
  engineLog.loadStarted = 0;
  releaseLoad = null;
  await mod.onLoad(pi);
  await sleep(900);
  // onLoad 会自动加载已选壁纸（scene），它会再次挂在 inst.load() 上，
  // 把 state.loading 一直置为 true 从而挡住后续点击 —— 先放行它。
  if (releaseLoad) releaseLoad();
  await sleep(1500);
  const trigger2 = layers.filter((l) => l.isConnected).flatMap((l) => l.childNodes).find((n) => n.className === "piwe-trigger");
  trigger2.dispatch("click");
  await sleep(900);
  const list2 = items();
  const videoIdx2 = list2.findIndex((n) => textOf(n).includes("视频播放"));
  if (videoIdx2 < 0) throw new Error("第二次加载后没找到 video 条目");
  list2[videoIdx2].dispatch("click");
  await sleep(4000);

  const video = liveChildren().find((n) => n.tagName === "VIDEO");
  check("video 已进入舞台", Boolean(video));
  const hadUrl = video ? video.src : "";
  check("video 持有 blob URL", Boolean(hadUrl) && liveUrls.has(hadUrl), hadUrl);

  mod.onUnload();
  await sleep(400);

  check("卸载后 video 的 blob URL 已回收", !liveUrls.has(hadUrl), hadUrl);
  check("卸载后没有任何 blob URL 泄漏", liveUrls.size === 0, `剩 ${liveUrls.size}`);
  check("卸载后舞台已移除", !findStage());
  check("卸载后没有 DOM 残留 canvas/video", documentStub.documentElement.childNodes
    .flatMap(function walk(n) { return [n, ...(n.childNodes || []).flatMap(walk)]; })
    .filter((n) => n.tagName === "VIDEO" || n.tagName === "CANVAS").length === 0);

  await pluginMain.onUnload();

  // 收尾：清掉测试生成的载荷
  const payloadDir = path.join(PLUGIN_DIR, "payload");
  if (fs.existsSync(payloadDir)) {
    for (const name of fs.readdirSync(payloadDir)) { try { fs.unlinkSync(path.join(payloadDir, name)); } catch {} }
    try { fs.rmdirSync(payloadDir); } catch {}
  }

  console.log(`\n${failures === 0 ? "UNLOAD_TEST_OK" : `UNLOAD_TEST_FAILED (${failures} 项)`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e && e.stack ? e.stack : e); process.exit(1); });
