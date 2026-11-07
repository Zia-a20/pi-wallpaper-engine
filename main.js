"use strict";

/**
 * Wallpaper Engine 动态背景 —— PI-Desktop 插件主进程入口。
 *
 * 运行在 PI 独立的插件 Node 进程中，可以使用原始 node 模块。
 * 主窗口（renderer）通过 plugin.call 调用这里的方法：
 *   plugin.call 单次 args + answer 合计不能超过 64KB，超时 2s，限速 10 次/秒，
 *   连续失败 5 次会熔断 30 秒。因此壁纸图片一律切片传输，绝不整包返回。
 *
 * 所有外部调用（注册表、文件系统）都包 try/catch，任何异常都不能让插件进入 load_error。
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

const sourceLib = require("./wallpaper-source.js");

/** Wallpaper Engine 在 Steam 里的 AppID。 */
const WORKSHOP_APP_ID = "431960";

/** 单块原始字节数：base64 后约 48KB，给 JSON 留足余量，保证远低于 64KB 上限。 */
const CHUNK_BYTES = 36 * 1024;

/** 预览图体积上限，超过则拒绝传输（避免用户长时间等待 + 高频 IPC）。 */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/**
 * 视频壁纸体积上限。
 *
 * 这个上限**不再和 IPC 有关**：视频现在走 payload/vid-*.js 载荷文件，
 * 由 plugin-renderer: 以 <script> 流式加载，完全不过 plugin.call 的 10QPS / 64KB 限制。
 * 所以这里只防「读进内存会撑爆」的极端情况：300MB 的 mp4 编码成 base64 约 400MB，
 * 再加上解码后的 Buffer，峰值接近 1GB。超过这个量级就回落预览图，避免直接把进程搞死。
 */
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

// 载荷相关常量（目录名 / 文件名前后缀）统一由 wallpaper-source.js 维护，这里不再重复声明。

const MIME_BY_EXT = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** 列表条目与标题长度上限，确保 library.list 的返回值不会撞上 64KB 上限。 */
const MAX_LIST_ENTRIES = 120;
const MAX_TITLE_CHARS = 120;

const PREVIEW_EXTENSIONS = [".gif", ".jpg", ".jpeg", ".png", ".webp", ".avif"];

const DEFAULT_SETTINGS = {
  enabled: true,
  selectedId: "",
  /** 画面压暗程度 0~0.95，越大越暗，用来保证文字可读。 */
  dim: 0.55,
  /** 侧栏/顶栏玻璃底色不透明度 0~1。 */
  glass: 0.55,
  /** 玻璃模糊半径（px）。 */
  blur: 16,
  /** 图片填充方式。 */
  fit: "cover",
};

const state = {
  config: { ...DEFAULT_SETTINGS },
  /** 扫描到的壁纸列表。 */
  wallpapers: [],
  /** id -> 壁纸条目，供越权校验使用。 */
  byId: new Map(),
  /** id -> Buffer，首次取块时读入内存并复用。 */
  buffers: new Map(),
  /** 发现到的 Steam 库根目录，仅用于诊断展示。 */
  roots: [],
  lastScanAt: 0,
  /**
   * 插件包自身目录（绝对路径）。
   * plugin-renderer: 协议只服务插件目录内的文件，所以载荷必须落在这里面。
   */
  pluginDir: "",
  /** id -> 已生成的载荷相对路径，切换壁纸时用来决定淘汰时保住哪个文件。 */
  payloads: new Map(),
  /** 启动清扫的定时器句柄，onUnload 时清掉。 */
  sweepTimer: null,
};

/** 启动清扫延迟：避开插件刚启动时的写盘高峰，也不拖慢 onLoad。 */
const STARTUP_SWEEP_DELAY_MS = 3000;
/** 定时器句柄（模块级，供 onUnload 清理）。 */
let sweepTimer = null;

// ---------------------------------------------------------------- 基础工具

function sleepNotNeeded() {}

/** 读取配置目录（家目录下的隐藏目录），失败时回退到临时目录。 */
function configDir() {
  try {
    return path.join(os.homedir(), ".pi-wallpaper-engine");
  } catch {
    try {
      return path.join(os.tmpdir(), "pi-wallpaper-engine");
    } catch {
      return null;
    }
  }
}

function configFile() {
  const dir = configDir();
  return dir ? path.join(dir, "config.json") : null;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function sanitizeSettings(input) {
  const raw = input && typeof input === "object" ? input : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
    selectedId: typeof raw.selectedId === "string" ? raw.selectedId : DEFAULT_SETTINGS.selectedId,
    dim: clampNumber(raw.dim, 0, 0.95, DEFAULT_SETTINGS.dim),
    glass: clampNumber(raw.glass, 0, 1, DEFAULT_SETTINGS.glass),
    blur: Math.round(clampNumber(raw.blur, 0, 40, DEFAULT_SETTINGS.blur)),
    fit: raw.fit === "contain" ? "contain" : "cover",
  };
}

function readConfig() {
  try {
    const file = configFile();
    if (!file || !fs.existsSync(file)) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return sanitizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeConfig(next) {
  try {
    const dir = configDir();
    const file = configFile();
    if (!dir || !file) return false;
    fs.mkdirSync(dir, { recursive: true });
    // 先写临时文件再改名，避免写一半掉电导致配置损坏。
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** child === parent 不算“在内部”；用于防止预览图路径越界。 */
function isInside(parent, child) {
  try {
    const rel = path.relative(parent, child);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    try {
      return path.resolve(target);
    } catch {
      return null;
    }
  }
}

function truncateTitle(text, fallback) {
  const value = typeof text === "string" ? text.trim() : "";
  const label = value || fallback;
  const chars = Array.from(label);
  return chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS).join("") : label;
}

// ---------------------------------------------------------------- Steam 发现

/** 从注册表读 Steam 安装路径（HKCU 下，最可靠）。失败返回 null。 */
function steamPathFromRegistry() {
  return new Promise((resolve) => {
    try {
      execFile(
        "reg",
        ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
        { windowsHide: true, timeout: 4000 },
        (error, stdout) => {
          if (error || !stdout) return resolve(null);
          const match = String(stdout).match(/SteamPath\s+REG_SZ\s+(.+)/i);
          resolve(match ? match[1].trim() : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/** 解析 libraryfolders.vdf 里的所有 "path"。 */
function libraryPathsFromVdf(vdfPath) {
  const found = [];
  try {
    if (!fs.existsSync(vdfPath)) return found;
    const text = fs.readFileSync(vdfPath, "utf8");
    const re = /"path"\s+"([^"]+)"/gi;
    let match;
    while ((match = re.exec(text)) !== null) {
      const raw = match[1].replace(/\\\\/g, "\\");
      if (raw) found.push(raw);
    }
  } catch {
    // 解析失败就当没有，交给兜底路径。
  }
  return found;
}

/** 常见安装位置兜底（不写死任何用户专属路径）。 */
function fallbackSteamRoots() {
  const guesses = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim()) guesses.push(value.trim());
  };
  try {
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    push(programFilesX86 ? path.join(programFilesX86, "Steam") : "");
    push(programFiles ? path.join(programFiles, "Steam") : "");
  } catch {
    // 环境变量不可用时忽略。
  }
  try {
    // 盘符根目录下的常见拼写。
    const driveRoots = ["C:\\", "D:\\", "E:\\", "F:\\"];
    for (const root of driveRoots) {
      push(path.join(root, "Steam"));
      push(path.join(root, "SteamLibrary"));
    }
  } catch {
    // 忽略。
  }
  return guesses;
}

/** 汇总所有 Steam 库根目录（去重、只看真实存在的）。 */
async function discoverSteamRoots() {
  const candidates = [];
  const registryPath = await steamPathFromRegistry();
  if (registryPath) candidates.push(registryPath);

  for (const base of candidates.slice()) {
    try {
      candidates.push(...libraryPathsFromVdf(path.join(base, "steamapps", "libraryfolders.vdf")));
    } catch {
      // 忽略。
    }
  }
  candidates.push(...fallbackSteamRoots());

  const roots = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = safeRealpath(candidate);
    if (!resolved) continue;
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(key);
    roots.push(resolved);
  }
  return roots;
}

// ---------------------------------------------------------------- 壁纸扫描

/** 在一个目录里挑选预览图：优先 project.json 指定的，其次目录内的图片。 */
function pickPreviewFile(dir, preferred) {
  const tryFile = (name) => {
    if (typeof name !== "string" || !name.trim()) return null;
    const target = path.join(dir, name);
    try {
      const stats = fs.statSync(target);
      if (!stats.isFile()) return null;
      if (!PREVIEW_EXTENSIONS.includes(path.extname(target).toLowerCase())) return null;
      return { file: target, size: stats.size };
    } catch {
      return null;
    }
  };

  const preferredHit = tryFile(preferred);
  if (preferredHit) return preferredHit;

  // 兜底：目录里按 preview.* 的优先级找一个。
  for (const ext of PREVIEW_EXTENSIONS) {
    const hit = tryFile(`preview${ext}`);
    if (hit) return hit;
  }
  return null;
}

/** 读文件修改时间（毫秒）；读不到返回 0。载荷摘要要用它判断源文件是否变了。 */
function readMtimeMs(file) {
  try {
    const stats = fs.statSync(file);
    return stats.isFile() ? stats.mtimeMs : 0;
  } catch {
    return 0;
  }
}

/**
 * 从文件头解析图片像素尺寸，不依赖任何第三方库。
 * 支持 GIF / PNG / JPEG / WebP。解析不出来返回 null。
 */
function readImageSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(32);
    const read = fs.readSync(fd, head, 0, 32, 0);
    if (read < 12) return null;

    // GIF: "GIF8" 后面紧跟小端宽高。
    if (head.toString("latin1", 0, 3) === "GIF") {
      return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
    }
    // PNG: IHDR 固定在第 16 字节起，大端。
    if (head[0] === 0x89 && head.toString("latin1", 1, 4) === "PNG") {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    // WebP: RIFF....WEBP，VP8X 存 24 位宽高。
    if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
      const chunk = head.toString("latin1", 12, 16);
      if (chunk === "VP8X" && read >= 30) {
        const w = 1 + (head[24] | (head[25] << 8) | (head[26] << 16));
        const h = 1 + (head[27] | (head[28] << 8) | (head[29] << 16));
        return { width: w, height: h };
      }
      if (chunk === "VP8 " && read >= 30) {
        return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === "VP8L" && read >= 25) {
        const bits = head[21] | (head[22] << 8) | (head[23] << 16) | (head[24] << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    // JPEG: 逐段扫描 SOFn。
    if (head[0] === 0xff && head[1] === 0xd8) {
      const buf = fs.readFileSync(file);
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        if (len < 2) break;
        i += 2 + len;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 忽略。 */ }
    }
  }
}

/** 递归收集目录内的图片文件（跳过程序资源目录，避免把 UI 贴图当成背景）。 */
function collectImageFiles(dir, depth, out, budget) {
  if (depth > 3 || out.length >= budget) return;
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (out.length >= budget) return;
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      collectImageFiles(full, depth + 1, out, budget);
      continue;
    }
    if (!dirent.isFile()) continue;
    if (!PREVIEW_EXTENSIONS.includes(path.extname(dirent.name).toLowerCase())) continue;
    try {
      const stats = fs.statSync(full);
      // 只考虑能完整搬运的文件：超过上限的会被 assets.meta 拒绝。
      if (stats.size > MAX_ASSET_BYTES) continue;
      out.push({ file: full, size: stats.size });
    } catch {
      // 单个文件读失败忽略。
    }
  }
}

/**
 * 在壁纸目录里挑最高清的图片当背景。
 *
 * 为什么需要这个：创意工坊的 preview.gif / preview.jpg 往往只有 160~224 像素，
 * 拉到全屏必然模糊。而工程内部常有真正的高清原图（例如 web 壁纸的 3840x2160
 * 背景图）。优先按「像素数最多」挑，像素数相同才退回文件更大者（动图更细腻）。
 * 找不到比预览图更清晰的图时返回 null，调用方继续用预览图。
 */
function pickHiResImage(dir, previewPath) {
  const candidates = [];
  collectImageFiles(dir, 0, candidates, 400);
  if (!candidates.length) return null;

  const previewReal = safeRealpath(previewPath);
  const previewSize = previewReal ? readImageSize(previewReal) : null;
  const previewPixels = previewSize ? previewSize.width * previewSize.height : 0;

  let best = null;
  for (const candidate of candidates) {
    const real = safeRealpath(candidate.file);
    if (!real) continue;
    // 必须在壁纸目录内部，防止符号链接逃逸。
    if (!isInside(dir, real)) continue;
    const size = readImageSize(real);
    if (!size || !size.width || !size.height) continue;
    const pixels = size.width * size.height;
    if (pixels <= previewPixels) continue;
    if (!best || pixels > best.pixels || (pixels === best.pixels && candidate.size > best.size)) {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(real).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      best = { file: real, size: candidate.size, mtimeMs, pixels, width: size.width, height: size.height };
    }
  }
  return best;
}

/** 读取 project.json，失败时返回 null（中文标题可能导致编码问题，不依赖它）。 */
function readProjectJson(dir) {
  const file = path.join(dir, "project.json");
  try {
    if (!fs.existsSync(file)) return null;
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 把一个壁纸目录解析成列表条目，解析不出来返回 null。 */
function buildEntry(dir, source) {
  const project = readProjectJson(dir);
  const type = project && typeof project.type === "string" ? project.type : "";
  // application 是 Wallpaper Engine 的“应用类”项目，没有可展示的静态预览。
  if (type === "application") return null;

  const preview = pickPreviewFile(dir, project && typeof project.preview === "string" ? project.preview : "");
  if (!preview) return null;

  const id = path.basename(dir);
  const realDir = safeRealpath(dir);
  const realPreview = safeRealpath(preview.file);
  if (!realDir || !realPreview) return null;
  // 预览图必须落在壁纸目录内部，防止被 project.json 指向别处。
  if (!isInside(realDir, realPreview)) return null;

  const title = truncateTitle(project && project.title, id);
  // 三种类型分别怎么拿到「真实画面」：
  //
  // scene  —— 画面是 scene.pkg 里的纹理实时合成的，目录里根本没有成品图。
  //            所以 preview 只当首帧占位，真正的画面由渲染端用 WebWallGL 跑引擎输出。
  // video  —— 目录里通常有 mp4，比 preview.jpg 清晰得多且本来就是动的。
  //            但字节要经 plugin.call 搬运（10QPS 硬顶），超上限就回落 preview。
  // web    —— 本身就是网页，网页引用的背景大图（常 3840x2160）就是最终画面，直接用。
  const previewSize = readImageSize(realPreview);
  const pkg = type === "scene" ? sourceLib.findScenePkg(realDir) : null;
  const video = type === "video" ? sourceLib.findVideoFile(realDir, project) : null;
  const asset = type === "web" ? pickHiResImage(realDir, realPreview) : null;

  const assetPath = asset ? asset.file : realPreview;
  const assetExt = path.extname(assetPath).toLowerCase();
  const width = asset ? asset.width : previewSize ? previewSize.width : 0;
  const height = asset ? asset.height : previewSize ? previewSize.height : 0;

  // 三类都能走「真画面」通道（载荷文件 + 渲染端自取）：
  //   scene  -> 引擎实时渲染 scene.pkg
  //   video  -> <video> 解码 mp4
  //   image  -> 直接铺原图（web 壁纸的 4K 图，或未超上限的预览图）
  // 只有视频超过搬运上限、或图片超过上限时才留空，渲染端回落 preview 分块通道。
  const imageBytes = asset ? asset.size : preview.size;
  const imageUsable = imageBytes > 0 && imageBytes <= MAX_ASSET_BYTES;
  const liveKind = pkg
    ? "scene"
    : video && video.size <= MAX_VIDEO_BYTES
      ? "video"
      : imageUsable
        ? "image"
        : "";

  return {
    id,
    title,
    type: type || "unknown",
    source,
    previewName: path.basename(realPreview),
    /** 实际用于铺背景的文件（可能是高清图，也可能是预览图）。 */
    assetName: path.basename(assetPath),
    assetPath,
    previewPath: realPreview,
    isHd: Boolean(asset),
    width,
    height,
    size: asset ? asset.size : preview.size,
    mime: MIME_BY_EXT[assetExt] || "application/octet-stream",
    dir: realDir,
    /** "scene" 走引擎真渲染，"video" 走 <video> 真播放，"image" 直接铺原图，空串表示只有静态图。 */
    liveKind,
    /** scene.pkg 的绝对路径与体积（仅 scene 类有）。 */
    pkgPath: pkg ? pkg.file : "",
    pkgSize: pkg ? pkg.size : 0,
    pkgMtimeMs: pkg ? pkg.mtimeMs : 0,
    /** 视频文件绝对路径与体积（仅 video 类且不超上限时有）。 */
    videoPath: video ? video.file : "",
    videoSize: video ? video.size : 0,
    videoMtimeMs: video ? video.mtimeMs : 0,
    /**
     * 静态图（assetPath）的修改时间。
     * 载荷文件名是内容摘要，必须把 mtime 算进去：Steam 换图不改路径，
     * 只有 mtime/size 变了才能让旧缓存自动失配。
     */
    assetMtimeMs: asset ? asset.mtimeMs : readMtimeMs(assetPath),
    /** video 类超过搬运上限时置位，渲染端据此提示用户。 */
    videoTooLarge: Boolean(video && video.size > MAX_VIDEO_BYTES),
  };
}

/** 扫描全部 Steam 库里的创意工坊壁纸与本地的 Wallpaper Engine 工程。 */
async function scanWallpapers() {
  const roots = await discoverSteamRoots();
  state.roots = roots;

  const entries = [];
  const seenIds = new Set();

  const addFromDirectory = (dir, source) => {
    try {
      const stats = fs.statSync(dir);
      if (!stats.isDirectory()) return;
    } catch {
      return;
    }
    const entry = buildEntry(dir, source);
    if (!entry) return;
    const key = `${entry.source}:${entry.id}`;
    if (seenIds.has(key)) return;
    seenIds.add(key);
    entries.push(entry);
  };

  for (const root of roots) {
    // 创意工坊订阅的壁纸。
    const workshopRoot = path.join(root, "steamapps", "workshop", "content", WORKSHOP_APP_ID);
    try {
      if (fs.existsSync(workshopRoot)) {
        for (const dirent of fs.readdirSync(workshopRoot, { withFileTypes: true })) {
          if (!dirent.isDirectory()) continue;
          addFromDirectory(path.join(workshopRoot, dirent.name), "workshop");
        }
      }
    } catch {
      // 单个库读失败不影响其它库。
    }

    // Wallpaper Engine 安装目录里的本地工程。
    const weRoot = path.join(root, "steamapps", "common", "wallpaper_engine");
    const projectsRoot = path.join(weRoot, "projects");
    try {
      if (fs.existsSync(projectsRoot)) {
        for (const dirent of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
          if (!dirent.isDirectory()) continue;
          addFromDirectory(path.join(projectsRoot, dirent.name), "local");
        }
      }
    } catch {
      // 忽略。
    }
  }

  // 按标题排序：readdirSync 返回的是文件系统顺序（基本随机的数字 id 序），
  // 壁纸一多就完全找不到东西。用中文排序规则 + 数字感知，让「壁纸 2」排在「壁纸 10」前面。
  // 参考 DSH 原项目 lib/wallpaper-scan.js 的 localeCompare 做法。
  entries.sort((a, b) => {
    try {
      return String(a.title || "").localeCompare(String(b.title || ""), "zh-Hans-CN", {
        numeric: true,
        sensitivity: "base",
      });
    } catch {
      // 老 Node 或 locale 不可用时退回简单比较，绝不让排序失败拖垮整个扫描。
      return String(a.title || "") < String(b.title || "") ? -1 : 1;
    }
  });

  state.wallpapers = entries;
  state.byId = new Map(entries.map((entry) => [entry.id, entry]));
  state.buffers.clear();
  state.lastScanAt = Date.now();

  // 已选中的壁纸消失了就清空选择。
  if (state.config.selectedId && !state.byId.has(state.config.selectedId)) {
    state.config.selectedId = "";
    writeConfig(state.config);
  }
  return entries;
}

/** 确保已经扫描过（首次调用时惰性扫描）。 */
async function ensureScanned() {
  if (state.lastScanAt > 0) return state.wallpapers;
  return scanWallpapers();
}

// ---------------------------------------------------------------- 资源读取

/**
 * 读取单个文件为资源元信息，顺带做越界 / 体积校验。
 * 返回 { error } 或 { buffer, size, mime, path }。
 */
function readAssetFile(entry, file) {
  const real = safeRealpath(file);
  if (!real) return { error: "outside_scope" };
  // 资源必须落在壁纸目录内部，防止绕过扫描结果读取任意文件。
  if (!isInside(entry.dir, real)) return { error: "outside_scope" };

  let stats;
  try {
    stats = fs.statSync(real);
  } catch {
    return { error: "missing_file" };
  }
  if (!stats.isFile()) return { error: "not_a_file" };
  // 高清图可能远超 8MB，此时直接判超限，由调用方回落到预览图。
  if (stats.size > MAX_ASSET_BYTES) return { error: "too_large", size: stats.size };

  try {
    const buffer = fs.readFileSync(real);
    const ext = path.extname(real).toLowerCase();
    return {
      buffer,
      size: buffer.length,
      mime: MIME_BY_EXT[ext] || "application/octet-stream",
      path: real,
    };
  } catch {
    return { error: "read_failed" };
  }
}

/**
 * 读取资源字节并缓存。
 * 优先用高清图（assetPath），任何一步失败都回落到预览图（previewPath），
 * 这样即使个别壁纸的高清图超大或损坏，也仍然有背景可看。
 */
function loadAssetBuffer(id) {
  if (state.buffers.has(id)) return state.buffers.get(id);
  const entry = state.byId.get(id);
  if (!entry) return { error: "unknown_id" };

  let loaded = readAssetFile(entry, entry.assetPath || entry.previewPath);
  let usedFallback = false;
  if (loaded.error) {
    if (!entry.previewPath || entry.previewPath === entry.assetPath) return loaded;
    loaded = readAssetFile(entry, entry.previewPath);
    usedFallback = true;
    if (loaded.error) return loaded;
  }

  const meta = {
    buffer: loaded.buffer,
    size: loaded.size,
    mime: loaded.mime,
    usedFallback,
  };
  state.buffers.set(id, meta);
  return meta;
}

// ---------------------------------------------------------------- RPC 方法

const handlers = {
  /** 返回当前配置 + 发现到的库根目录。 */
  "settings.get"(args) {
    if (args && typeof args === "object" && args.settings && typeof args.settings === "object") {
      state.config = sanitizeSettings(args.settings);
      writeConfig(state.config);
    }
    return {
      ok: true,
      settings: { ...state.config },
      roots: state.roots.slice(),
      scanned: state.lastScanAt > 0,
      count: state.wallpapers.length,
    };
  },

  /** 局部更新配置并落盘。 */
  "settings.set"(args) {
    const patch = args && typeof args === "object" ? args.patch : null;
    if (!patch || typeof patch !== "object") return { ok: false, error: "invalid_patch" };
    state.config = sanitizeSettings({ ...state.config, ...patch });
    writeConfig(state.config);
    return { ok: true, settings: { ...state.config } };
  },

  /** 返回壁纸列表；不含任何图片字节，确保远低于 64KB。 */
  async "library.list"() {
    const entries = await ensureScanned();
    const items = entries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      source: entry.source,
      size: entry.size,
      previewName: entry.previewName,
      /** 实际背景源文件名，便于用户判断是否拿到高清图。 */
      assetName: entry.assetName,
      width: entry.width,
      height: entry.height,
      isHd: entry.isHd,
      /** "scene" / "video" 表示能真渲染真播放，空串表示只能铺静态图。 */
      liveKind: entry.liveKind,
      /** 载荷原始体积，界面上用来解释「为什么要等一两秒」。 */
      // 三类各自对应自己的源文件：scene -> scene.pkg，video -> mp4，image -> 高清原图。
      // liveKind 为空（视频 / 图片超上限）时必须给 0，别让界面报出假的体积。
      liveBytes: entry.liveKind === "scene"
        ? entry.pkgSize
        : entry.liveKind === "video"
          ? entry.videoSize
          : entry.liveKind === "image"
            ? entry.size
            : 0,
      /** 视频超过搬运上限时为 true，界面提示改用预览图。 */
      videoTooLarge: entry.videoTooLarge,
    }));
    return {
      ok: true,
      wallpapers: items,
      total: entries.length,
      truncated: entries.length > items.length,
      current: state.config.selectedId,
      roots: state.roots.slice(0, 8),
    };
  },

  /** 强制重新扫描。 */
  async "library.scan"() {
    const entries = await scanWallpapers();
    return {
      ok: true,
      total: entries.length,
      current: state.config.selectedId,
      roots: state.roots.slice(0, 8),
    };
  },

  /** 选择壁纸并持久化。 */
  "wallpaper.select"(args) {
    const id = args && typeof args === "object" ? String(args.id || "") : "";
    if (!id) {
      state.config.selectedId = "";
      writeConfig(state.config);
      return { ok: true, current: "" };
    }
    if (!state.byId.has(id)) return { ok: false, error: "unknown_id" };
    state.config.selectedId = id;
    writeConfig(state.config);
    return { ok: true, current: id };
  },

  /** 取资源元信息（体积 / MIME / 分块信息）。 */
  "assets.meta"(args) {
    const id = args && typeof args === "object" ? String(args.id || "") : "";
    if (!id) return { ok: false, error: "invalid_id" };
    const loaded = loadAssetBuffer(id);
    if (loaded.error) return { ok: false, error: loaded.error, size: loaded.size || 0 };
    return {
      ok: true,
      id,
      size: loaded.size,
      mime: loaded.mime,
      chunkBytes: CHUNK_BYTES,
    };
  },

  /** 取一块数据：base64 编码，渲染端按 offset 串行推进。 */
  "assets.chunk"(args) {
    if (!args || typeof args !== "object") return { ok: false, error: "invalid_args" };
    const id = String(args.id || "");
    const offset = Number(args.offset);
    if (!id || !Number.isFinite(offset) || offset < 0) return { ok: false, error: "invalid_args" };

    const loaded = loadAssetBuffer(id);
    if (loaded.error) return { ok: false, error: loaded.error };

    const start = Math.floor(offset);
    if (start >= loaded.size) return { ok: false, error: "offset_out_of_range" };
    const end = Math.min(loaded.size, start + CHUNK_BYTES);
    const slice = loaded.buffer.subarray(start, end);
    return {
      ok: true,
      b64: slice.toString("base64"),
      next: end,
      eof: end >= loaded.size,
      size: loaded.size,
    };
  },

  /**
   * 为 scene / video / image 壁纸生成或复用载荷文件，返回渲染端可直接拼成协议 URL 的相对路径。
   *
   * 这是 v4 的核心：不搬运字节，只告诉渲染端「去哪加载」。
   * 40MB 的包在这里被编码成 54MB 的 .js，之后由 Chromium 自己流式读取。
   * 文件名是「id + 路径 + 大小 + mtime + 生成器版本」的 sha256 摘要，
   * 因此命中缓存时连源文件都不用读（重复加载 ~1ms，以前要整读 106MB）。
   */
  "assets.payload"(args) {
    if (!state.pluginDir) return { ok: false, error: "no_plugin_dir" };
    const id = args && typeof args === "object" ? String(args.id || "") : "";
    if (!id) return { ok: false, error: "invalid_id" };
    const entry = state.byId.get(id);
    if (!entry) return { ok: false, error: "unknown_id" };

    const target = sourceLib.describePayload(entry);
    if (!target || !target.source) {
      if (entry.videoTooLarge) return { ok: false, error: "video_too_large", bytes: entry.videoSize };
      if (entry.type === "scene") return { ok: false, error: "no_scene_pkg" };
      if (entry.type === "video") return { ok: false, error: "no_video_file" };
      return { ok: false, error: "too_large", bytes: entry.size };
    }

    // 二次越权校验：条目里的路径在扫描时已校验过，这里重算一次真实路径再比。
    const real = sourceLib.safeRealpath(target.source);
    if (!real || !sourceLib.isInside(entry.dir, real)) return { ok: false, error: "outside_scope" };

    // 载荷文件名是内容摘要：先只 stat 源文件算出名字，文件已存在就直接复用。
    const spec = { id, kind: target.kind, source: real };
    const plan = sourceLib.payloadInfo(state.pluginDir, spec);
    if (!plan || plan.bytes === 0) return { ok: false, error: "read_failed" };

    if (target.kind === "scene" && !plan.exists) {
      // 只在真要生成时校验 PKGV 魔数，而且只读开头 16 字节：
      // 不是有效场景包就别白编 190MB 的载荷。
      if (!sourceLib.hasPkgvMagic(real)) return { ok: false, error: "not_pkgv" };
    }

    let built;
    try {
      built = sourceLib.ensurePayload(state.pluginDir, spec);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (message === "source_unreadable" || message === "empty_source") {
        return { ok: false, error: "read_failed" };
      }
      return { ok: false, error: "encode_failed", message };
    }

    state.payloads.set(id, built.rel);

    // 每次生成后顺手按容量上限淘汰一次：刚生成的这个一定保住。
    let pruned = [];
    try {
      pruned = sourceLib.prunePayloads(state.pluginDir, built.rel).removed;
    } catch {
      pruned = [];
    }

    return {
      ok: true,
      id,
      kind: target.kind,
      rel: built.rel,
      name: built.name,
      bytes: built.bytes,
      created: built.created,
      pruned,
      /**
       * image / video 建 Blob 时要用正确的 MIME。
       * 注意不能沿用 entry.mime —— 那是按「预览图」扩展名算的：
       * video 壁纸的预览是 preview.jpg（会变成 image/jpeg），
       * scene 壁纸的预览是 preview.gif（会变成 image/gif）。
       * 只有 scene 的 MIME 无意义（引擎吃字节，不看类型）。
       */
      mime: target.kind === "scene"
        ? "application/octet-stream"
        : MIME_BY_EXT[path.extname(real).toLowerCase()] || "application/octet-stream",
    };
  },

  /**
   * 排障 / 手动清理：扫掉孤儿临时文件，并按容量上限淘汰一次载荷。
   * 日常清理在 assets.payload 生成成功后自动进行，这个方法只给用户和诊断用。
   */
  "assets.cleanup"() {
    if (!state.pluginDir) return { ok: false, error: "no_plugin_dir" };
    const keep = state.config.selectedId ? state.payloads.get(state.config.selectedId) || "" : "";
    try {
      const swept = sourceLib.sweepPayloadTemp(state.pluginDir);
      // 旧版（固定 id 命名）遗留的载荷：留着永远用不上，顺手清掉。
      const legacy = sourceLib.sweepLegacyPayloads(state.pluginDir);
      const pruned = sourceLib.prunePayloads(state.pluginDir, keep);
      const usage = sourceLib.payloadUsage(state.pluginDir);
      return {
        ok: true,
        removed: pruned.removed,
        swept,
        legacy,
        limitBytes: sourceLib.PAYLOAD_MAX_BYTES,
      };
    } catch (error) {
      return { ok: false, error: "cleanup_failed", message: String(error && error.message ? error.message : error) };
    }
  },
};

/** 宿主回调：所有 plugin.call 都从这里进来。 */
async function onRendererCall(method, args) {
  const handler = handlers[String(method || "")];
  if (!handler) return { ok: false, error: "unknown_method" };
  try {
    return await handler(args);
  } catch (error) {
    // 任何异常都必须变成可读的错误，不能抛回宿主。
    return { ok: false, error: "handler_failed", message: String(error && error.message ? error.message : error) };
  }
}

// ---------------------------------------------------------------- 生命周期
/**
 * 启动清扫：延迟几秒后清掉孤儿临时文件，并按容量上限淘汰一次载荷。
 *
 * 为什么延迟：插件刚起来时，渲染端可能正在写载荷。等 3 秒既避开写盘高峰，
 * 又不会拖慢启动（宿主对 onLoad 有超时）。
 * 全部步骤独立 try/catch：任何一步失败都不能影响背景功能。
 */
function scheduleStartupSweep() {
  if (sweepTimer || !state.pluginDir) return;
  try {
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      if (!state.pluginDir) return;
      try {
        sourceLib.sweepPayloadTemp(state.pluginDir);
      } catch {
        // 清扫失败无所谓，下次启动再来。
      }
      try {
        // 旧版按固定 id 命名的载荷：新命名永不匹配，留着就是白占磁盘。
        sourceLib.sweepLegacyPayloads(state.pluginDir);
      } catch {
        // 同上。
      }
      try {
        const keep = state.config.selectedId ? state.payloads.get(state.config.selectedId) || "" : "";
        sourceLib.prunePayloads(state.pluginDir, keep);
      } catch {
        // 同上。
      }
    }, STARTUP_SWEEP_DELAY_MS);
    // 定时器不该拖住宿主进程退出。
    if (sweepTimer && typeof sweepTimer.unref === "function") sweepTimer.unref();
  } catch {
    sweepTimer = null;
  }
}


async function onLoad() {
  state.config = readConfig();
  // 记录插件包目录：载荷文件必须写在这里面，plugin-renderer: 才会分发。
  try {
    state.pluginDir = __dirname;
  } catch {
    state.pluginDir = "";
  }

  scheduleStartupSweep();

  try {
    await pi.commands.register({
      id: "io.github.zia-a20.wallpaper-engine.status",
      title: "Wallpaper Engine: 查看壁纸库状态",
      keywords: ["wallpaper", "壁纸", "背景"],
      run: async () => {
        try {
          const entries = await ensureScanned();
          const current = state.byId.get(state.config.selectedId);
          const message = entries.length
            ? `已发现 ${entries.length} 张壁纸${current ? `，当前：${current.title}` : ""}`
            : "没有发现壁纸库，请确认 Wallpaper Engine 已安装并订阅过壁纸";
          await pi.ui.showToast(message);
        } catch {
          await pi.ui.showToast("扫描壁纸库失败");
        }
      },
    });
  } catch {
    // 命令注册失败不影响背景功能。
  }
}

async function onUnload() {
  try {
    await pi.commands.unregister("io.github.zia-a20.wallpaper-engine.status");
  } catch {
    // 忽略。
  }
  // 清掉启动清扫定时器：插件被禁用后不该再有后台任务跑。
  if (sweepTimer) {
    try {
      clearTimeout(sweepTimer);
    } catch {
      // 忽略。
    }
    sweepTimer = null;
  }
  state.sweepTimer = null;
  state.buffers.clear();
  state.byId.clear();
  state.payloads.clear();
  state.wallpapers = [];
}

module.exports = { onLoad, onUnload, onRendererCall };
