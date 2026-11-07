"use strict";

/**
 * Wallpaper Engine 动态背景 —— PI 主窗口渲染端。
 *
 * 设计要点（全部由宿主限制反推而来）：
 *
 * 1. 背景舞台（stage）直接挂在 document.body 上，不放进 pi.ui.openLayer() 的容器。
 *    因为 layer 在界面挂起（弹窗/主题切换）时会被加 hidden/inert，背景不能跟着消失。
 *
 * 2. 画面怎么拿到 —— 宿主主窗口 origin 是 file://，CSP 是 connect-src 'self'，
 *    fetch 读不到本地文件；plugin.call 又限速 10 次/秒、单次 args+answer 合计 ≤64KB，
 *    40MB 的 scene.pkg 要走 93 秒。但宿主的 plugin-renderer:// 是 standard+secure+stream
 *    特权协议，处理器直接 readFileSync 后返回 Response（无体积上限），CSP 的 script-src
 *    也放行了它。于是 main.js 把字节编码进插件目录里的一个 .js 载荷文件，
 *    这里用 <script src="plugin-renderer://..."> 让 Chromium 自己流式读盘（本机约 0.6 秒），
 *    再用原生 atob 解码（42MB 约 134ms）。整条链路零 IPC。
 *
 * 3. 三种壁纸三种画法：
 *    scene —— 用 WebWallGL 引擎实时渲染 scene.pkg，是真正的高清动态画面；
 *    video —— 字节拼 Blob 交给 <video>（CSP 的 media-src 允许 blob:）；
 *    image —— 直接铺原图（web 壁纸的 3840×2160 就是最终画面）。
 *    全部失败时回落 preview 分块通道，至少还有静态图。
 *
 * 4. 不覆盖 --ds-bg-primary（它同时被当作文字色使用），而是把各层容器背景改成透明，
 *    让背景从下面透出来；侧栏/输入框用半透明 + backdrop-filter 做玻璃效果。
 *
 * 全部外部调用都包 try/catch：渲染端 onLoad 抛错会导致插件 renderer 加载失败。
 */

/** 单次 plugin.call 之间的最小间隔（毫秒）。10 次/秒是滑动窗口限速，留余量走 8 次/秒。 */
const CHUNK_GAP_MS = 125;

/** 分块请求遇到限速时的最大重试次数。 */
const CALL_MAX_RETRY = 3;

/** 背景舞台与全局样式表的固定 id，便于重复加载时复用/清理。 */
const STAGE_ID = "piwe-stage";
const THEME_STYLE_ID = "piwe-theme-style";

/** 引擎文件相对插件根目录的路径（与 main.js 的 vendor/ 目录对应）。 */
const ENGINE_REL = "vendor/webwallgl.global.min.js";

/**
 * 场景渲染帧率。24 帧对背景足够（电影也是 24），比 30 帧再省约 20% GPU。
 * 需要更顺滑可调回 30；这个值只影响 scene 类壁纸。
 */
const SCENE_FPS = 24;

/**
 * 遮挡降级：失焦时把场景降到多少帧。
 * 别的应用抢了前台，壁纸多半被窗口盖住，但双屏用户还能瞄到一眼，
 * 所以不完全停画，只把重绘频率砍到零头。
 */
const OCCLUDED_FPS = 6;

/**
 * 遮挡判定的去抖时间（毫秒）。
 * 拖动窗口、快速 Alt-Tab 会连续产生 blur/focus，不去抖就会反复 pause/resume，
 * 开销反而比一直画更大。
 */
const OCCLUSION_DEBOUNCE_MS = 120;

/** 壁纸类型的中文标签。 */
const TYPE_LABELS = {
  scene: "场景",
  video: "视频",
  web: "网页",
  unknown: "未知",
};

/** 全局可变状态：整个渲染端只有一个实例，卸载时统一清理。 */
const state = {
  pi: null,
  settings: null,
  /** openLayer 返回的 layer 句柄。 */
  layer: null,
  /** 舞台节点：容器 / 预览图 / 真画面容器 / 压暗层。 */
  stage: null,
  previewImg: null,
  liveBox: null,
  scrim: null,
  /** 当前正在播放的 blob URL（video / img），切换或卸载时要 revoke。 */
  objectUrl: "",
  /** 预览图当前用的 blob URL。必须单独记，否则换图时旧的永远回收不掉。 */
  previewUrl: "",
  /** WebWallGL 场景实例（仅 scene 类有）。 */
  engineInst: null,
  /** 真画面里的节点（canvas 所在容器 / video / img）。 */
  liveNode: null,
  /** 当前已经成功显示出来的壁纸 id 与画法，避免重复加载。 */
  loadedId: "",
  loadedKind: "",
  /** 是否正在搬运/渲染。 */
  loading: false,
  /** 加载令牌：切换壁纸时递增，旧任务回来后发现自己过期就丢弃结果。 */
  loadToken: 0,
  /** 插件根目录的协议 URL（由 import.meta.url 推导）。 */
  baseUrl: "",
  /** 已加载过的脚本 URL -> Promise，避免重复注入同一份 54MB 载荷。 */
  scriptLoads: new Map(),
  /** 设置面板的 DOM 引用。 */
  panel: null,
  /** 最近一次 library.list 的结果，以及按 id 的索引。 */
  items: [],
  itemById: new Map(),
  /** 由 pi.ui.injectStyle 返回的清理函数。 */
  styleDisposer: null,
  /** 右下角入口按钮及其所在 layer。 */
  trigger: null,
  triggerLayer: null,
  /** 已注册的全局事件监听清理函数。 */
  cleanup: [],
  /** 页面是否被隐藏（最小化 / 切走标签页）：整棵子树不显示，停画零代价。 */
  hidden: false,
  /** 窗口是否失去焦点：壁纸多半被别的窗口盖住，降到低帧而不是全停。 */
  unfocused: false,
  /** 卸载标记：异步任务回来后不能再碰 DOM。 */
  disposed: false,
};

// ---------------------------------------------------------------- 通用工具

/** 简易 sleep。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 创建元素的小帮手，减少重复代码。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === "string") node.textContent = text;
  return node;
}

/** base64 -> Uint8Array。分块数据与载荷都是 base64 编码的二进制。 */
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  // 必须逐字节回填 charCodeAt：漏掉这一步会得到一整块 0x00，
  // Blob 拼出来的「图片」解码必然失败，背景就只剩兜底色。
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 把字节数变成人能读的大小。 */
function formatBytes(bytes) {
  const num = Number(bytes) || 0;
  if (num >= 1024 * 1024) return `${(num / 1024 / 1024).toFixed(1)}MB`;
  if (num >= 1024) return `${Math.round(num / 1024)}KB`;
  return `${num}B`;
}

/**
 * 统一的 RPC 入口。
 * 遇到宿主限速（PLUGIN_CALL_RATE_LIMITED）或熔断冷却时退避重试，
 * 其它错误直接抛出，交给调用方决定怎么展示。
 */
async function call(method, args) {
  let attempt = 0;
  for (;;) {
    try {
      return await state.pi.dispatch("plugin.call", { method, args: args || {} });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      const code = String(error && error.code ? error.code : "");
      const retryable = /RATE_LIMITED|DISABLED|TIMEOUT/.test(message) || /RATE_LIMITED|DISABLED|TIMEOUT/.test(code);
      if (!retryable || attempt >= CALL_MAX_RETRY) throw error;
      attempt += 1;
      await sleep(350 * attempt);
    }
  }
}

// ---------------------------------------------------------------- 插件资源定位

/**
 * 推导插件根目录的 URL。
 *
 * 本模块是从 plugin-renderer://<id>/g<generation>/renderer/index.mjs 加载的，
 * 所以 new URL("../", import.meta.url) 就是插件根目录，vendor/ 与 payload/ 都在它下面。
 * generation 段不参与宿主的路径计算，因此这个前缀天然跟着宿主的每次加载走。
 */
function resolveBaseUrl() {
  if (state.baseUrl) return state.baseUrl;
  try {
    const here = import.meta.url;
    if (typeof here === "string" && here) {
      state.baseUrl = new URL("../", here).href;
      return state.baseUrl;
    }
  } catch {
    // 解析失败就交给调用方回落预览图。
  }
  return "";
}

/**
 * 注入一个脚本并等它执行完。
 *
 * 默认不缓存：载荷脚本只会把一次性数据挂到 window.__PIWE_ASSET，
 * 用完立刻被置 null，所以第二次切回同一张壁纸必须重新执行脚本，
 * 否则 <script> 已经被浏览器执行过、再挂同一个 URL 不会再跑一次，
 * 结果就是「切回来变预览图」。只有引擎脚本是幂等的，可以传 cache=true。
 */
function loadScript(url, cache) {
  // 只有幂等脚本（引擎）才允许命中缓存；载荷必须每次真执行。
  if (cache && state.scriptLoads.has(url)) return state.scriptLoads.get(url);
  const task = new Promise((resolve, reject) => {
    try {
      const node = document.createElement("script");
      node.src = url;
      node.async = true;
      node.addEventListener("load", () => {
        // 全局变量已经挂在 window 上，节点本身可以撤掉。
        try {
          node.remove();
        } catch {
          // 忽略。
        }
        resolve();
      });
      node.addEventListener("error", () => {
        try {
          node.remove();
        } catch {
          // 忽略。
        }
        // 失败的不缓存，下次还会重试。
        state.scriptLoads.delete(url);
        reject(new Error(`脚本加载失败：${url}`));
      });
      (document.head || document.documentElement).appendChild(node);
    } catch (error) {
      state.scriptLoads.delete(url);
      reject(error);
    }
  });
  state.scriptLoads.set(url, task);
  return task;
}

/** 取（必要时加载）WebWallGL 引擎。 */
async function ensureEngine() {
  if (window.WebWallGL) return window.WebWallGL;
  const base = resolveBaseUrl();
  if (!base) throw new Error("无法定位插件目录");
  // 引擎脚本是幂等的，允许缓存：切壁纸不必重读 1MB 的引擎。
  await loadScript(new URL(ENGINE_REL, base).href, true);
  if (!window.WebWallGL) throw new Error("引擎脚本已加载但没有挂载 window.WebWallGL");
  return window.WebWallGL;
}

// ---------------------------------------------------------------- 背景舞台

/** 取（必要时创建）舞台节点。挂在 body 最前面，保证在所有内容之下。 */
function ensureStage() {
  if (state.stage && state.stage.isConnected) return state.stage;

  const stage = document.createElement("div");
  stage.id = STAGE_ID;
  // 自带主题色兜底：图片还没加载或加载失败时，界面看起来和原生一致。
  //
  // fixed + z-index -1 会画在 html 背景之上、普通内容背景之下，
  // 所以只要把上层容器改成透明，背景就能透出来。
  stage.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:-1",
    "pointer-events:none",
    "overflow:hidden",
    "background:var(--ds-bg-primary)",
  ].join(";");

  // 第一层：预览图。先铺上它，用户立刻有画面；真画面就绪后淡出。
  const previewImg = document.createElement("img");
  previewImg.alt = "";
  previewImg.decoding = "async";
  previewImg.dataset.role = "preview";
  previewImg.style.cssText = [
    "position:absolute",
    "inset:0",
    "width:100%",
    "height:100%",
    "object-fit:cover",
    "object-position:center",
    "opacity:0",
    "transition:opacity 480ms ease",
    "display:block",
  ].join(";");

  // 第二层：真画面（canvas / video / img），天然盖在预览图之上。
  const liveBox = document.createElement("div");
  liveBox.dataset.role = "live";
  liveBox.style.cssText = [
    "position:absolute",
    "inset:0",
    "opacity:0",
    "transition:opacity 520ms ease",
  ].join(";");

  // 第三层：压暗层。用主题底色而不是纯黑，浅色主题下才不会把深色文字压到看不清。
  const scrim = document.createElement("div");
  scrim.style.cssText = ["position:absolute", "inset:0", "pointer-events:none"].join(";");

  stage.appendChild(previewImg);
  stage.appendChild(liveBox);
  stage.appendChild(scrim);

  const parent = document.body || document.documentElement;
  parent.insertBefore(stage, parent.firstChild);

  state.stage = stage;
  state.previewImg = previewImg;
  state.liveBox = liveBox;
  state.scrim = scrim;
  return stage;
}

/** 当前的填充方式。 */
function fitValue() {
  const settings = state.settings;
  return settings && settings.fit === "contain" ? "contain" : "cover";
}

/** 把设置里的压暗/填充比例同步到舞台节点上。 */
function applyVisuals() {
  const settings = state.settings;
  if (!settings) return;
  const fit = fitValue();
  if (state.previewImg) state.previewImg.style.objectFit = fit;
  // 真画面里的 video / img 也要跟着走；canvas 由引擎的 setFit 管。
  if (state.liveNode) {
    if (state.liveNode instanceof HTMLVideoElement || state.liveNode instanceof HTMLImageElement) {
      state.liveNode.style.objectFit = fit;
    }
  }
  if (state.engineInst) {
    try {
      state.engineInst.setFit(fit);
    } catch {
      // 实例可能已销毁，忽略。
    }
  }
  if (state.scrim) {
    // 用 color-mix 让压暗层跟随主题：暗色主题压成深色，浅色主题压成浅色。
    const percent = Math.round(Math.max(0, Math.min(0.95, settings.dim)) * 100);
    state.scrim.style.background = percent > 0
      ? `color-mix(in oklab, var(--ds-bg-primary) ${percent}%, transparent)`
      : "transparent";
  }
  // 全局变量驱动侧栏玻璃与模糊强度。
  const root = document.documentElement;
  if (root && root.style) {
    root.style.setProperty("--piwe-glass", String(Math.max(0, Math.min(1, settings.glass))));
    root.style.setProperty("--piwe-blur", `${Math.round(Math.max(0, Math.min(40, settings.blur)))}px`);
  }
}

/** 彻底清空真画面：销毁引擎实例、撤回 blob URL、清空容器。 */
function clearLive() {
  const inst = state.engineInst;
  state.engineInst = null;
  if (inst) {
    try {
      inst.destroy();
    } catch {
      // 已销毁就忽略。
    }
  }
  if (state.objectUrl) {
    try {
      URL.revokeObjectURL(state.objectUrl);
    } catch {
      // 忽略。
    }
    state.objectUrl = "";
  }
  if (state.liveBox) {
    try {
      while (state.liveBox.firstChild) state.liveBox.removeChild(state.liveBox.firstChild);
    } catch {
      // 忽略。
    }
    state.liveBox.style.opacity = "0";
  }
  state.liveNode = null;
  if (state.loadedKind && state.loadedKind !== "preview") state.loadedKind = "";
}

/** 清空预览图并释放 blob URL。 */
function clearPreview() {
  if (state.previewImg) {
    state.previewImg.style.opacity = "0";
    try {
      state.previewImg.removeAttribute("src");
    } catch {
      // 忽略。
    }
  }
  // 只摘 src 不会回收 blob：必须显式 revoke，否则每换一次壁纸泄一个 URL。
  if (state.previewUrl) {
    try {
      URL.revokeObjectURL(state.previewUrl);
    } catch {
      // 忽略。
    }
    state.previewUrl = "";
  }
}

/** 清空全部画面，恢复到只有主题底色。 */
function clearBackground() {
  try {
    clearLive();
  } catch {
    // 忽略。
  }
  try {
    clearPreview();
  } catch {
    // 忽略。
  }
  state.loadedId = "";
  state.loadedKind = "";
}

/** 显示预览图（先淡出旧的，再淡入新的）。 */
async function showPreview(url) {
  const img = state.previewImg;
  if (!img) return;
  img.style.opacity = "0";
  await sleep(200);
  // 淡出这 200ms 里插件可能已被卸载：此时不能再建 URL，直接回收。
  if (state.disposed) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // 忽略。
    }
    return;
  }
  // 旧预览的 URL 必须先记下来：它在 img.src 被替换后就再也读不到，会永久泄漏。
  const previous = state.previewUrl || img.getAttribute("src") || "";
  state.previewUrl = url;
  img.src = url;
  // decode 可以确保首帧就绪后再淡入，避免闪一下空白；失败也不影响显示。
  try {
    await img.decode();
  } catch {
    // 忽略。
  }
  // 真画面已经就绪时不要再用预览图盖住它。
  if (state.liveNode) {
    img.style.opacity = "0";
    if (state.previewUrl === url) state.previewUrl = "";
    try {
      URL.revokeObjectURL(url);
    } catch {
      // 忽略。
    }
    return;
  }
  img.style.opacity = "1";
  if (previous && previous.startsWith("blob:") && previous !== url) {
    try {
      URL.revokeObjectURL(previous);
    } catch {
      // 忽略。
    }
  }
}

/** 真画面已就绪：淡入它、淡出预览图。 */
function revealLive() {
  if (state.previewImg) state.previewImg.style.opacity = "0";
  if (state.liveBox) state.liveBox.style.opacity = "1";
}

// ---------------------------------------------------------------- 遮挡降级（省 GPU）

/** 遮挡判定的去抖定时器。 */
let occlusionTimer = null;

/**
 * 当前真画面应该处于哪种档位。
 *
 * - hidden：页面整体不可见（最小化 / 切走），画面没人看得到，全停。
 * - unfocused：窗口失焦，壁纸多半被别的窗口盖住，降到 OCCLUDED_FPS。
 * - active：正常前台，回到 SCENE_FPS。
 */
function occlusionLevel() {
  if (state.hidden) return "hidden";
  if (state.unfocused) return "unfocused";
  return "active";
}

/**
 * 按当前档位驱动真画面。
 *
 * 每次都重新读 state：切换壁纸的过程中它可能已经指向新节点，缓存会打错目标。
 */
function applyOcclusion() {
  const level = occlusionLevel();
  const inst = state.engineInst;
  const node = state.liveNode;

  if (inst) {
    try {
      if (level === "hidden") {
        // 完全不可见：停掉渲染循环，GPU 直接归零。
        if (typeof inst.pause === "function") inst.pause();
      } else {
        // 失焦时降帧，前台时回到正常帧率；两种情况都要先确保在跑。
        if (typeof inst.resume === "function") inst.resume();
        if (typeof inst.setFps === "function") {
          inst.setFps(level === "unfocused" ? OCCLUDED_FPS : SCENE_FPS);
        }
      }
    } catch {
      // 引擎正在重建（如 setRenderDpr）时调用可能抛错，忽略。
    }
  }

  // 视频：解码器比 WebGL 更费电，只要不是前台就停，不必留低帧。
  if (node && typeof HTMLVideoElement !== "undefined" && node instanceof HTMLVideoElement) {
    try {
      if (level === "active") {
        const played = node.play();
        if (played && typeof played.catch === "function") {
          played.catch(() => {});
        }
      } else if (!node.paused) {
        node.pause();
      }
    } catch {
      // 忽略。
    }
  }
}

/**
 * 重算档位，带去抖。
 *
 * 拖动窗口会连续触发 blur/focus，不去抖就会反复 pause/resume，
 * 每次都要重建渲染节拍，开销可能比一直画还大。
 */
function scheduleOcclusion() {
  if (occlusionTimer !== null) {
    try {
      clearTimeout(occlusionTimer);
    } catch {
      // 忽略。
    }
  }
  occlusionTimer = setTimeout(() => {
    occlusionTimer = null;
    if (state.disposed) return;
    applyOcclusion();
  }, OCCLUSION_DEBOUNCE_MS);
  // 让 Node 环境下的测试进程不会被这个定时器挂住。
  if (occlusionTimer && typeof occlusionTimer.unref === "function") occlusionTimer.unref();
}

/**
 * 安装遮挡监听。
 *
 * 浏览器拿不到窗口遮挡状态，只能用两个最接近的代理：
 * document.hidden（最小化 / 切走）与窗口焦点（别的应用抢了前台）。
 * 这正是桌面壁纸引擎功耗常年接近 0 的关键。
 *
 * @returns {() => void} 卸载函数。
 */
function installOcclusionGuard() {
  const onVisibility = () => {
    try {
      state.hidden = Boolean(document.hidden);
    } catch {
      state.hidden = false;
    }
    scheduleOcclusion();
  };
  const onBlur = () => {
    state.unfocused = true;
    scheduleOcclusion();
  };
  const onFocus = () => {
    state.unfocused = false;
    scheduleOcclusion();
  };

  try {
    // 先同步一次初值：插件可能在窗口已失焦时热重载。
    state.hidden = Boolean(document.hidden);
  } catch {
    // 忽略。
  }

  try {
    document.addEventListener("visibilitychange", onVisibility);
  } catch {
    // 忽略。
  }
  try {
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
  } catch {
    // 忽略。
  }

  return () => {
    try {
      document.removeEventListener("visibilitychange", onVisibility);
    } catch {
      // 忽略。
    }
    try {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    } catch {
      // 忽略。
    }
    if (occlusionTimer !== null) {
      try {
        clearTimeout(occlusionTimer);
      } catch {
        // 忽略。
      }
      occlusionTimer = null;
    }
  };
}

// ---------------------------------------------------------------- 分块搬运（兜底）

/**
 * 按 offset 串行拉取整张预览图。
 * 每块之间强制等待 CHUNK_GAP_MS，确保不会撞上宿主 10 次/秒的限速。
 */
async function fetchPreviewBlob(id, onProgress) {
  const meta = await call("assets.meta", { id });
  if (!meta || !meta.ok) {
    throw new Error(meta && meta.error === "too_large" ? "预览图超过 8MB，已跳过" : `无法读取壁纸（${(meta && meta.error) || "unknown"}）`);
  }

  const total = Number(meta.size) || 0;
  const parts = [];
  let offset = 0;
  let guard = 0;

  for (;;) {
    guard += 1;
    // 8MB / 36KB ≈ 233 块，给足冗余；超过说明协议异常，直接中断。
    if (guard > 2048) throw new Error("分块数量异常，已中断");

    // 已卸载就立刻收手：不再白白消耗宿主的 10QPS 配额。
    if (state.disposed) throw new Error("已取消");

    if (offset > 0) await sleep(CHUNK_GAP_MS);

    const chunk = await call("assets.chunk", { id, offset });
    if (!chunk || !chunk.ok) throw new Error(`分块读取失败（${(chunk && chunk.error) || "unknown"}）`);

    parts.push(base64ToBytes(chunk.b64));
    offset = Number(chunk.next) || 0;
    if (typeof onProgress === "function") {
      onProgress(Math.min(offset, total), total);
    }
    if (chunk.eof) break;
  }

  return new Blob(parts, { type: meta.mime || "application/octet-stream" });
}

// ---------------------------------------------------------------- 真画面渲染

/** 从载荷脚本里取出字节。载荷是 main.js 生成的 window.__PIWE_ASSET = {id, kind, b64}。 */
async function fetchPayloadBytes(id) {
  const info = await call("assets.payload", { id });
  if (!info || !info.ok) {
    throw new Error(`载荷不可用（${(info && info.error) || "unknown"}）`);
  }
  const base = resolveBaseUrl();
  if (!base) throw new Error("无法定位插件目录");

  // 加个一次性参数：同一个载荷被再次加载时必须真的重新执行脚本。
  // 宿主对 plugin-renderer: 回了 cache-control:no-store，但 <script> 节点复用时
  // 浏览器仍可能按 URL 命中「已执行」的记录，加参数最稳。
  const url = new URL(String(info.rel || ""), base);
  url.searchParams.set("v", String(Date.now()));
  await loadScript(url.href);

  const pack = window.__PIWE_ASSET;
  if (!pack || typeof pack.b64 !== "string") throw new Error("载荷脚本没有产出数据");
  if (String(pack.id) !== String(id)) throw new Error("载荷内容与所选壁纸不匹配");

  const b64 = pack.b64;
  // 立刻放手：54MB 的字符串没必要一直挂在 window 上。
  try {
    window.__PIWE_ASSET = null;
  } catch {
    // 忽略。
  }
  const bytes = base64ToBytes(b64);
  return { bytes, kind: String(pack.kind || info.kind || ""), mime: String(info.mime || "") };
}

/** 创建 scene 真渲染画面。 */
async function renderScene(bytes) {
  const lib = await ensureEngine();
  if (state.disposed) throw new Error("已取消");

  const host = document.createElement("div");
  host.dataset.role = "scene";
  host.style.cssText = ["position:absolute", "inset:0", "width:100%", "height:100%"].join(";");
  state.liveBox.appendChild(host);

  const inst = lib.createScene(host, { fit: fitValue(), fps: SCENE_FPS, volume: 0 });
  state.engineInst = inst;
  try {
    inst.on("error", (event) => {
      console.warn("[wallpaper-engine] 引擎报错", event && event.message ? event.message : event);
    });
  } catch {
    // 老版本可能没有 on()，不影响加载。
  }

  try {
    await inst.load(lib.bytesSource(bytes));
  } catch (error) {
    // 装配失败就把容器撤掉，让上层回落到预览图。
    try {
      inst.destroy();
    } catch {
      // 忽略。
    }
    state.engineInst = null;
    try {
      host.remove();
    } catch {
      // 忽略。
    }
    throw error;
  }
  // 等待 load 期间插件可能已被卸载：必须自己把刚建好的东西收干净，
  // 否则 WebGL 上下文和 canvas 会留在文档里泄漏。
  // 注意不要重复销毁：若 onUnload 里的 clearLive 已经收走并销毁过，
  // state.engineInst 就不再指向它，此时再 destroy 属于多余调用。
  if (state.disposed) {
    if (state.engineInst === inst) {
      try {
        inst.destroy();
      } catch {
        // 忽略。
      }
      state.engineInst = null;
    }
    try {
      host.remove();
    } catch {
      // 忽略。
    }
    throw new Error("已取消");
  }
  // load 期间窗口可能已经失焦/最小化：立刻套用当前档位，别等下一次事件。
  applyOcclusion();
  return inst;
}

/** 创建 video 真播放画面。 */
function renderVideo(bytes, mime) {
  const blob = new Blob([bytes], { type: mime || "video/mp4" });
  const url = URL.createObjectURL(blob);
  state.objectUrl = url;

  const video = document.createElement("video");
  video.src = url;
  video.loop = true;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.autoplay = true;
  video.setAttribute("autoplay", "");
  video.style.cssText = [
    "position:absolute",
    "inset:0",
    "width:100%",
    "height:100%",
    `object-fit:${fitValue()}`,
    "object-position:center",
    "display:block",
  ].join(";");
  state.liveBox.appendChild(video);
  state.liveNode = video;
  // 是否播放交给遮挡档位决定：窗口已经在后台时不该白解码一个视频。
  applyOcclusion();
  return video;
}

/** 创建高清单图画面。 */
function renderImage(bytes, mime) {
  const blob = new Blob([bytes], { type: mime || "image/jpeg" });
  const url = URL.createObjectURL(blob);
  state.objectUrl = url;

  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.src = url;
  img.style.cssText = [
    "position:absolute",
    "inset:0",
    "width:100%",
    "height:100%",
    `object-fit:${fitValue()}`,
    "object-position:center",
    "display:block",
  ].join(";");
  state.liveBox.appendChild(img);
  state.liveNode = img;
  return img;
}

/**
 * 加载指定壁纸的真画面。
 *
 * 只要拿到真画面就立刻显示；任何一步失败都抛出，由调用方回落预览图。
 * 松手时 cb 的百分比只为让面板有话可说，载荷一步到位，不做假进度。
 */
async function startLive(id) {
  const payload = await fetchPayloadBytes(id);
  if (state.disposed) throw new Error("已取消");
  if (!payload.bytes || payload.bytes.length === 0) throw new Error("载荷为空");

  if (payload.kind === "scene") {
    // 校验 PKGV 魔数：拿到的不是场景包就没必要喂给引擎。
    if (payload.bytes.length < 16 || String.fromCharCode(...payload.bytes.subarray(4, 8)) !== "PKGV") {
      throw new Error("载荷不是有效的 scene.pkg");
    }
    await renderScene(payload.bytes);
    return "scene";
  }
  if (payload.kind === "video") {
    renderVideo(payload.bytes, payload.mime);
    return "video";
  }
  if (payload.kind === "image") {
    renderImage(payload.bytes, payload.mime);
    return "image";
  }
  throw new Error(`未知载荷类型（${payload.kind || "?"}）`);
}

// ---------------------------------------------------------------- 壁纸加载总控

/**
 * 加载并显示指定壁纸。
 *
 * 顺序：有真画面就先进真画面（比预览图更快也更清晰），
 * 失败才回落到 preview 分块通道；两者都失败就保留兜底底色，绝不把界面弄成空白。
 */
async function loadWallpaper(id, onProgress) {
  if (!id) {
    clearBackground();
    return;
  }
  if (state.loadedId === id && state.loadedKind) return;
  if (state.loading) return;

  state.loading = true;
  const token = (state.loadToken += 1);

  try {
    const item = state.itemById.get(id);
    const liveKind = item && item.liveKind ? String(item.liveKind) : "";
    const liveBytes = item && item.liveBytes ? Number(item.liveBytes) : 0;

    if (liveKind) {
      setStatus(`正在准备${TYPE_LABELS[item.type] || ""}画面${liveBytes ? `（${formatBytes(liveBytes)}）` : ""}…`);
      try {
        const kind = await startLive(id);
        if (state.disposed || token !== state.loadToken) {
          // 期间用户又切了别的壁纸：把刚建好的画面丢掉。
          clearLive();
          return;
        }
        state.loadedId = id;
        state.loadedKind = kind;
        revealLive();
        applyVisuals();
        setStatus("已应用");
        // 顺手清掉旧载荷，别让 54MB×N 堆在插件目录里。
        void (async () => {
          try {
            await call("assets.cleanup", {});
          } catch {
            // 清理失败不影响显示。
          }
        })();
        return;
      } catch (error) {
        if (state.disposed || token !== state.loadToken) return;
        const message = String(error && error.message ? error.message : error);
        console.warn("[wallpaper-engine] 真画面不可用，回落预览图：", message);
        setStatus(`真画面不可用（${message}），改用预览图…`);
      }
    }

    // 兜底：搬运预览图。
    let blob;
    try {
      blob = await fetchPreviewBlob(id, onProgress);
    } catch (error) {
      if (state.disposed || token !== state.loadToken) return;
      throw error;
    }
    if (state.disposed || token !== state.loadToken) return;

    const url = URL.createObjectURL(blob);
    await showPreview(url);
    if (state.disposed) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // 忽略。
      }
      return;
    }
    state.loadedId = id;
    state.loadedKind = "preview";
    if (!state.liveNode) setStatus("已应用（预览图）");
  } finally {
    if (token === state.loadToken) state.loading = false;
  }
}

// ---------------------------------------------------------------- 全局主题样式

/**
 * 全局透明化规则。
 * 必须自建 <style>：pi.ui.injectStyle 会把规则包进
 * @scope ([data-pi-plugin="..."]), 作用不到 html/body/.app-shell 这些祖先/全局节点。
 */
function themeCss() {
  return [
    // 把根节点链条全部透明化，让 z-index:-1 的舞台从下面透出来。
    "html,body,#root,",
    ".app-shell,.app-shell.settings-mode,",
    ".main-pane,.main-titlebar,.conversation-topbar,",
    ".transcript-settle-veil{",
    "  background:transparent !important;",
    "  background-color:transparent !important;",
    "  background-image:none !important;",
    "}",

    // 侧栏做成玻璃：底色跟主题、透明度可调。
    ".sidebar-surface,.sidebar-rail{",
    "  background-color:color-mix(in oklab, var(--ds-bg-sidebar, var(--ds-bg-primary)) calc(var(--piwe-glass, 0.55) * 100%), transparent) !important;",
    "  background-image:none !important;",
    "  backdrop-filter:blur(var(--piwe-blur, 16px)) saturate(1.15);",
    "  -webkit-backdrop-filter:blur(var(--piwe-blur, 16px)) saturate(1.15);",
    "}",

    // 输入框也半透明，否则底部会有一条硬边。
    ".composer-shell{",
    "  background-color:color-mix(in oklab, var(--ds-bg-elevated-primary, var(--ds-bg-primary)) calc(var(--piwe-glass, 0.55) * 100%), transparent) !important;",
    "  backdrop-filter:blur(var(--piwe-blur, 16px)) saturate(1.1);",
    "  -webkit-backdrop-filter:blur(var(--piwe-blur, 16px)) saturate(1.1);",
    "}",
  ].join("\n");
}

/** 写入/更新全局样式表。 */
function applyTheme() {
  try {
    let node = document.getElementById(THEME_STYLE_ID);
    if (!node) {
      node = document.createElement("style");
      node.id = THEME_STYLE_ID;
      document.head.appendChild(node);
    }
    node.textContent = themeCss();
  } catch {
    // 样式注入失败不影响画面层本身。
  }
}

/** 移除全局样式表，界面恢复原生外观。 */
function removeTheme() {
  try {
    const node = document.getElementById(THEME_STYLE_ID);
    if (node && node.parentNode) node.parentNode.removeChild(node);
  } catch {
    // 忽略。
  }
  try {
    const root = document.documentElement;
    if (root && root.style) {
      root.style.removeProperty("--piwe-glass");
      root.style.removeProperty("--piwe-blur");
    }
  } catch {
    // 忽略。
  }
}

// ---------------------------------------------------------------- 设置面板

/** 面板自己的样式。走 injectStyle，会被自动限制在插件的 layer 容器内。 */
const PANEL_CSS = `
.piwe-trigger{
  position:fixed;right:18px;bottom:18px;width:34px;height:34px;padding:0;
  display:flex;align-items:center;justify-content:center;
  border-radius:999px;border:1px solid var(--ds-border-subtle,rgba(255,255,255,.14));
  background:color-mix(in oklab, var(--ds-bg-elevated-primary,#1b1b1b) 82%, transparent);
  color:var(--ds-text-secondary,#b4b4b4);cursor:pointer;
  font-size:15px;line-height:1;opacity:.5;
  transition:opacity 160ms ease,color 160ms ease,transform 160ms ease;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  box-shadow:0 6px 18px rgba(0,0,0,.28);
}
.piwe-trigger:hover{opacity:1;color:var(--ds-text-primary,#ededed);transform:translateY(-1px)}
.piwe-trigger.is-off{color:var(--ds-text-muted,#8a8a8a)}

.piwe-panel{
  position:fixed;right:18px;bottom:62px;width:min(380px,calc(100vw - 36px));
  max-height:min(70vh,620px);display:flex;flex-direction:column;
  border-radius:14px;border:1px solid var(--ds-border-default,rgba(255,255,255,.12));
  background:var(--ds-bg-elevated-opaque,var(--ds-bg-elevated,#1b1b1b));
  color:var(--ds-text-primary,#ededed);
  box-shadow:0 18px 48px rgba(0,0,0,.42);overflow:hidden;
  font-size:13px;
}
.piwe-head{display:flex;align-items:center;justify-content:space-between;
  gap:12px;padding:12px 14px;border-bottom:1px solid var(--ds-border-subtle,rgba(255,255,255,.1));
  font-weight:600}
.piwe-head-title{display:flex;align-items:center;gap:8px}
.piwe-close{width:24px;height:24px;border:0;border-radius:6px;cursor:pointer;
  background:transparent;color:var(--ds-text-muted,#8a8a8a);font-size:14px}
.piwe-close:hover{background:var(--ds-bg-hover,rgba(255,255,255,.08));color:var(--ds-text-primary,#ededed)}
.piwe-body{padding:12px 14px;overflow:auto;display:flex;flex-direction:column;gap:12px}
.piwe-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.piwe-switch{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.piwe-switch input{accent-color:var(--ds-accent,#4c8dff);width:15px;height:15px;cursor:pointer}
.piwe-status{font-size:12px;color:var(--ds-text-muted,#8a8a8a);min-height:16px}
.piwe-list{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;
  border:1px solid var(--ds-border-subtle,rgba(255,255,255,.1));border-radius:9px;padding:4px}
.piwe-item{display:flex;align-items:center;gap:8px;width:100%;text-align:start;
  padding:7px 8px;border:0;border-radius:6px;cursor:pointer;background:transparent;
  color:var(--ds-text-secondary,#b4b4b4);font:inherit}
.piwe-item:hover{background:var(--ds-bg-hover,rgba(255,255,255,.08));color:var(--ds-text-primary,#ededed)}
.piwe-item.is-active{background:color-mix(in oklab, var(--ds-accent,#4c8dff) 18%, transparent);
  color:var(--ds-text-primary,#ededed)}
.piwe-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.piwe-tag{flex:none;font-size:11px;color:var(--ds-text-muted,#8a8a8a)}
.piwe-tag.is-hd{color:var(--ds-accent,#4c9eff);font-weight:600}
.piwe-empty{padding:10px;font-size:12px;color:var(--ds-text-muted,#8a8a8a);text-align:center}
.piwe-slider{display:flex;flex-direction:column;gap:4px}
.piwe-slider label{display:flex;justify-content:space-between;font-size:12px;
  color:var(--ds-text-secondary,#b4b4b4)}
.piwe-slider input[type=range]{width:100%;accent-color:var(--ds-accent,#4c8dff);cursor:pointer}
.piwe-foot{display:flex;gap:8px;padding:10px 14px;
  border-top:1px solid var(--ds-border-subtle,rgba(255,255,255,.1))}
.piwe-btn{flex:1;padding:7px 10px;border-radius:7px;cursor:pointer;font:inherit;
  border:1px solid var(--ds-border-subtle,rgba(255,255,255,.14));
  background:var(--ds-bg-hover,rgba(255,255,255,.06));color:var(--ds-text-primary,#ededed)}
.piwe-btn:hover{background:var(--ds-bg-active,rgba(255,255,255,.12))}
`;

/** 打开（或聚焦）设置面板。 */
function openPanel() {
  if (state.panel) {
    state.panel.style.display = "flex";
    return;
  }
  try {
    const layer = state.pi.ui.openLayer();
    state.layer = layer;
    const panel = buildPanel();
    layer.element.appendChild(panel);
    state.panel = panel;
    refreshPanel();
  } catch (error) {
    console.warn("[wallpaper-engine] 打开设置面板失败", error);
  }
}

/** 关闭面板。 */
function closePanel() {
  if (!state.panel) return;
  try {
    if (state.layer) state.layer.close();
  } catch {
    // 忽略。
  }
  state.panel = null;
  state.layer = null;
}

/** 组装面板 DOM（全部 createElement，避免 innerHTML 注入标题）。 */
function buildPanel() {
  const panel = el("div", "piwe-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "动态背景设置");

  // ---- 头部
  const head = el("div", "piwe-head");
  const headTitle = el("div", "piwe-head-title", "动态背景");
  const closeBtn = el("button", "piwe-close", "✕");
  closeBtn.type = "button";
  closeBtn.title = "关闭";
  closeBtn.addEventListener("click", () => closePanel());
  head.appendChild(headTitle);
  head.appendChild(closeBtn);

  // ---- 主体
  const body = el("div", "piwe-body");

  const enableRow = el("div", "piwe-row");
  const enableLabel = el("label", "piwe-switch");
  const enableInput = document.createElement("input");
  enableInput.type = "checkbox";
  enableInput.addEventListener("change", () => {
    patchSettings({ enabled: enableInput.checked });
  });
  enableLabel.appendChild(enableInput);
  enableLabel.appendChild(el("span", "", "启用壁纸背景"));
  enableRow.appendChild(enableLabel);
  body.appendChild(enableRow);

  const status = el("div", "piwe-status", "");
  status.dataset.role = "status";
  body.appendChild(status);

  const list = el("div", "piwe-list");
  list.dataset.role = "list";
  body.appendChild(list);

  // ---- 滑杆
  const sliders = el("div", "piwe-slider-group");
  const makeSlider = (key, label, min, max, step, format) => {
    const wrap = el("div", "piwe-slider");
    const lab = document.createElement("label");
    const nameSpan = el("span", "", label);
    const valueSpan = el("span", "", "");
    valueSpan.dataset.valueFor = key;
    lab.appendChild(nameSpan);
    lab.appendChild(valueSpan);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset.key = key;
    const sync = () => {
      const value = Number(input.value);
      valueSpan.textContent = format(value);
    };
    input.addEventListener("input", () => {
      sync();
      // 拖动时只更新预览，松手才落盘，避免高频写文件。
      applyDraft(key, Number(input.value));
    });
    input.addEventListener("change", () => {
      patchSettings({ [key]: Number(input.value) });
    });
    wrap.appendChild(lab);
    wrap.appendChild(input);
    sliders.appendChild(wrap);
    return { input, sync };
  };

  const dimSlider = makeSlider("dim", "画面压暗", 0, 0.95, 0.05, (v) => `${Math.round(v * 100)}%`);
  const glassSlider = makeSlider("glass", "玻璃不透明度", 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);
  const blurSlider = makeSlider("blur", "背景模糊", 0, 40, 1, (v) => `${Math.round(v)}px`);

  const fitWrap = el("div", "piwe-slider");
  const fitLabel = document.createElement("label");
  fitLabel.appendChild(el("span", "", "填充方式"));
  const fitSelect = document.createElement("select");
  fitSelect.dataset.key = "fit";
  fitSelect.style.cssText = "background:var(--ds-bg-elevated,rgba(255,255,255,.06));color:inherit;border-radius:6px;border:1px solid var(--ds-border-subtle,rgba(255,255,255,.14));padding:2px 6px;font:inherit";
  for (const [value, text] of [["cover", "铺满"], ["contain", "完整显示"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    fitSelect.appendChild(option);
  }
  fitSelect.addEventListener("change", () => patchSettings({ fit: fitSelect.value }));
  fitLabel.appendChild(fitSelect);
  fitWrap.appendChild(fitLabel);
  sliders.appendChild(fitWrap);
  body.appendChild(sliders);

  // ---- 底部按钮
  const foot = el("div", "piwe-foot");
  const rescanBtn = el("button", "piwe-btn", "重新扫描");
  rescanBtn.type = "button";
  rescanBtn.addEventListener("click", () => rescan());
  const clearBtn = el("button", "piwe-btn", "清除背景");
  clearBtn.type = "button";
  clearBtn.addEventListener("click", () => {
    patchSettings({ selectedId: "" });
    clearBackground();
  });
  foot.appendChild(rescanBtn);
  foot.appendChild(clearBtn);

  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(foot);

  // 存下引用，刷新时直接用。
  panel._refs = {
    enableInput,
    status,
    list,
    dimSlider,
    glassSlider,
    blurSlider,
    fitSelect,
  };
  return panel;
}

/** 拖动滑杆时的即时预览（不写盘、不走 RPC）。 */
function applyDraft(key, value) {
  if (!state.settings) return;
  state.settings = { ...state.settings, [key]: value };
  applyVisuals();
}

/** 把当前设置刷到面板控件上。 */
function syncControls() {
  const panel = state.panel;
  const settings = state.settings;
  if (!panel || !panel._refs || !settings) return;
  const refs = panel._refs;
  refs.enableInput.checked = Boolean(settings.enabled);
  for (const [slider, key] of [[refs.dimSlider, "dim"], [refs.glassSlider, "glass"], [refs.blurSlider, "blur"]]) {
    if (slider && slider.input.value !== String(settings[key])) {
      slider.input.value = String(settings[key]);
    }
    if (slider) slider.sync();
  }
  if (refs.fitSelect) refs.fitSelect.value = settings.fit === "contain" ? "contain" : "cover";
}

/** 设置状态行文本。 */
function setStatus(text) {
  const panel = state.panel;
  if (!panel || !panel._refs) return;
  panel._refs.status.textContent = text || "";
}

/** 渲染壁纸列表。 */
function renderList() {
  const panel = state.panel;
  if (!panel || !panel._refs) return;
  const list = panel._refs.list;
  while (list.firstChild) list.removeChild(list.firstChild);

  if (!state.items.length) {
    list.appendChild(el("div", "piwe-empty", "没有发现壁纸，点「重新扫描」"));
    return;
  }

  const current = state.settings ? state.settings.selectedId : "";
  for (const item of state.items) {
    const button = el("button", "piwe-item");
    button.type = "button";
    if (item.id === current) button.classList.add("is-active");
    button.title = `${item.title}（${item.id}）`;

    button.appendChild(el("span", "piwe-item-title", item.title));
    // 标注分辨率与画法：scene/video 是真渲染真播放，其余只是静态预览图。
    const res = item.width && item.height ? `${item.width}×${item.height}` : "";
    const liveText = item.liveKind === "scene"
      ? "动态渲染"
      : item.liveKind === "video"
        ? "视频播放"
        : item.liveKind === "image"
          ? (item.isHd ? "高清原图" : "原图")
          : "静态预览";
    const parts = [TYPE_LABELS[item.type] || item.type, res, liveText].filter(Boolean);
    const tag = el("span", "piwe-tag", parts.join(" · "));
    if (item.liveKind || item.isHd) tag.classList.add("is-hd");
    button.appendChild(tag);

    button.addEventListener("click", () => {
      if (state.loading) return;
      selectWallpaper(item.id);
    });
    list.appendChild(button);
  }
}

/** 刷新面板显示（设置 + 列表）。 */
async function refreshPanel() {
  if (!state.panel) return;
  syncControls();
  await fetchLibrary();
  syncControls();
}

/** 拉取壁纸列表并渲染。 */
async function fetchLibrary(force) {
  if (!state.panel) return;
  setStatus(force ? "正在重新扫描…" : "正在读取壁纸库…");
  try {
    const answer = force
      ? await call("library.scan", {})
      : await call("library.list", {});
    if (!answer || !answer.ok) {
      setStatus(`读取失败：${(answer && answer.error) || "unknown"}`);
      return;
    }
    let listed = answer;
    if (force) {
      // 扫描完再取一次列表，拿到新条目。
      listed = await call("library.list", {});
    }
    state.items = listed && listed.ok && Array.isArray(listed.wallpapers) ? listed.wallpapers : [];
    state.itemById = new Map(state.items.map((item) => [String(item.id), item]));
    renderList();
    const total = Number(listed && listed.total) || state.items.length;
    setStatus(total ? `共 ${total} 张壁纸` : "没有发现壁纸");
  } catch (error) {
    setStatus(`读取失败：${String(error && error.message ? error.message : error)}`);
  }
}

/** 重新扫描。 */
async function rescan() {
  await fetchLibrary(true);
}

/** 选择壁纸：落盘 + 立即加载。 */
async function selectWallpaper(id) {
  try {
    const answer = await call("wallpaper.select", { id });
    if (!answer || !answer.ok) {
      setStatus(`选择失败：${(answer && answer.error) || "unknown"}`);
      return;
    }
    if (state.settings) state.settings = { ...state.settings, selectedId: id };
    // 换壁纸必须先清掉旧画面，否则旧 canvas 会一直跑着占 GPU。
    clearBackground();
    renderList();
    syncControls();
    setStatus("正在加载壁纸…");
    await loadWallpaper(id, (loaded, total) => {
      const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
      setStatus(`正在搬运预览图… ${percent}%`);
    });
    if (state.loadedKind === "preview") setStatus("已应用（预览图）");
    else if (state.loadedKind) setStatus("已应用");
  } catch (error) {
    setStatus(`加载失败：${String(error && error.message ? error.message : error)}`);
  }
}

/** 保存设置并立即生效。 */
async function patchSettings(patch) {
  try {
    const answer = await call("settings.set", { patch });
    if (answer && answer.ok && answer.settings) {
      state.settings = answer.settings;
    } else if (state.settings) {
      state.settings = { ...state.settings, ...patch };
    }
  } catch {
    if (state.settings) state.settings = { ...state.settings, ...patch };
  }
  applyToStage();
  syncControls();
}

/**
 * 把当前设置整体作用到界面：开关决定是否挂背景。
 */
function applyToStage() {
  const settings = state.settings;
  if (!settings) return;

  if (!settings.enabled) {
    // 关掉时彻底移除舞台和透明化样式，界面完全回到原生外观。
    removeTheme();
    clearBackground();
    if (state.stage && state.stage.parentNode) state.stage.parentNode.removeChild(state.stage);
    state.stage = null;
    state.previewImg = null;
    state.liveBox = null;
    state.scrim = null;
    updateTrigger();
    return;
  }

  ensureStage();
  applyTheme();
  applyVisuals();
  updateTrigger();

  if (settings.selectedId) {
    // 后台加载，不阻塞界面；失败时保留兜底底色。
    if (state.loadedId !== settings.selectedId) {
      void loadWallpaper(settings.selectedId, (loaded, total) => {
        const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
        setStatus(`正在搬运预览图… ${percent}%`);
      }).catch((error) => {
        if (!state.disposed) setStatus(`加载失败：${String(error && error.message ? error.message : error)}`);
      });
    }
  } else {
    clearBackground();
  }
}

/** 更新触发按钮的显示状态（关闭背景时变暗）。 */
function updateTrigger() {
  const button = state.trigger;
  if (!button) return;
  const enabled = Boolean(state.settings && state.settings.enabled);
  button.classList.toggle("is-off", !enabled);
  button.title = enabled ? "动态背景设置" : "动态背景已关闭";
}

/** 创建右下角的入口按钮，放在 layer 里随插件一起挂起/销毁。 */
function ensureTrigger() {
  if (state.trigger && state.trigger.isConnected) return;
  try {
    const layer = state.pi.ui.openLayer();
    state.triggerLayer = layer;
    const button = el("button", "piwe-trigger", "◨");
    button.type = "button";
    button.title = "动态背景设置";
    button.addEventListener("click", () => {
      if (state.panel) {
        closePanel();
      } else {
        openPanel();
      }
    });
    layer.element.appendChild(button);
    state.trigger = button;
    updateTrigger();
  } catch {
    // 拿不到 layer 也不影响背景本身。
  }
}

// ---------------------------------------------------------------- 生命周期

export async function onLoad(pi) {
  state.pi = pi;
  // 每次加载都重置中断标记：热重载后同一个模块实例会被再次 onLoad。
  state.disposed = false;
  state.loadedId = "";
  state.loadedKind = "";

  // 面板样式：作用域被限制在本插件的 layer 容器内。
  try {
    state.styleDisposer = pi.ui.injectStyle(PANEL_CSS);
  } catch {
    state.styleDisposer = null;
  }

  // 读取持久化配置。失败就用默认值，绝不让 onLoad 抛错。
  try {
    const answer = await call("settings.get", {});
    state.settings = answer && answer.ok && answer.settings
      ? answer.settings
      : { enabled: true, selectedId: "", dim: 0.55, glass: 0.55, blur: 16, fit: "cover" };
  } catch {
    state.settings = { enabled: true, selectedId: "", dim: 0.55, glass: 0.55, blur: 16, fit: "cover" };
  }

  ensureTrigger();

  if (state.settings.enabled) {
    ensureStage();
    applyTheme();
    applyVisuals();
    updateTrigger();
  }

  // 后台完成首次加载，不阻塞插件进入 loaded 状态。
  void (async () => {
    try {
      // assets.* 依赖扫描结果的 id 表，先把列表拉回来。
      const listed = await call("library.list", {});
      if (listed && listed.ok && Array.isArray(listed.wallpapers)) {
        state.items = listed.wallpapers;
        state.itemById = new Map(state.items.map((item) => [String(item.id), item]));
      }
    } catch {
      // 扫描失败也不影响兜底底色。
    }
    try {
      applyToStage();
    } catch {
      // 忽略。
    }
  })();

  // Esc 关闭面板。
  try {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && state.panel) closePanel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    state.cleanup.push(() => window.removeEventListener("keydown", onKeyDown, true));
  } catch {
    // 忽略。
  }

  // 遮挡降级必须在真画面出现之前就装好：首次加载时窗口可能已经在后台。
  try {
    state.cleanup.push(installOcclusionGuard());
  } catch {
    // 监听装不上只是省不了电，不该影响壁纸显示。
  }
}

export function onUnload() {
  // 立刻置位中断标记：任何还在飞行中的任务都不会再碰 DOM。
  state.disposed = true;
  state.loadToken += 1;

  try {
    closePanel();
  } catch {
    // 忽略。
  }
  try {
    if (state.triggerLayer) state.triggerLayer.close();
  } catch {
    // 忽略。
  }
  state.trigger = null;
  state.triggerLayer = null;

  for (const dispose of state.cleanup) {
    try {
      dispose();
    } catch {
      // 忽略。
    }
  }
  state.cleanup = [];

  try {
    clearBackground();
  } catch {
    // 忽略。
  }
  try {
    if (state.stage && state.stage.parentNode) state.stage.parentNode.removeChild(state.stage);
  } catch {
    // 忽略。
  }
  state.stage = null;
  state.previewImg = null;
  state.liveBox = null;
  state.scrim = null;
  state.scriptLoads.clear();

  removeTheme();

  try {
    if (state.styleDisposer) state.styleDisposer();
  } catch {
    // 忽略。
  }
  state.styleDisposer = null;
  state.settings = null;
  state.items = [];
  state.itemById = new Map();
  state.loading = false;
  // 遮挡标记归零：热重载后由新的 installOcclusionGuard 重新取初值。
  state.hidden = false;
  state.unfocused = false;
}
