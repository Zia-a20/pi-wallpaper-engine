"use strict";

/**
 * 壁纸「真实画面」的来源解析与载荷生成。
 *
 * 拆成独立模块的原因：这部分逻辑要反复在测试里单独跑（编码 40MB 的包很慢），
 * 和插件主流程混在一个文件里不好验证。本模块不依赖 main.js 的任何状态，
 * 所有路径都由调用方传入。
 *
 * 关键背景（为什么只能这么做）：
 * - scene 壁纸的画面是 scene.pkg 里的纹理实时合成的，没有「一张大图」可以拿来当背景。
 * - 宿主主窗口 origin 是 file://，CSP 是 connect-src 'self'，fetch 读不到本地文件；
 *   plugin.call 又限速 10 次/秒、单次 64KB，40MB 要搬约 93 秒。
 * - 但宿主的 plugin-renderer:// 是 standard+secure+stream 特权协议，处理器直接
 *   readFileSync 后返回 Response，没有体积上限，CSP 的 script-src 也放行了它。
 *   于是把字节编码进一个 .js 文件放进插件目录，让 Chromium 流式加载（本机约 0.6 秒）。
 * - video 壁纸同理：28MB 的 4K mp4 走 plugin.call 要 85 秒，走这条路只要 1 秒多。
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

/** 载荷目录名；必须位于插件包内部，plugin-renderer: 只服务插件目录内的文件。 */
const PAYLOAD_DIR_NAME = "payload";

/**
 * 载荷文件名前缀：按类型分开，清理时精确匹配，绝不误删用户文件。
 * scene 用 pkg-，video 用 vid-，高清静态图用 img-。
 */
const PAYLOAD_PREFIXES = { scene: "pkg-", video: "vid-", image: "img-" };

/** 载荷文件名后缀。必须是 .js：plugin-renderer: 的 MIME 白名单只有 js/mjs/css/json/map。 */
const PAYLOAD_SUFFIX = ".js";

/**
 * 生成器版本号：改了 base64 封装/文件头格式就 bump 它。
 * 作用是一次性让所有旧载荷失效 —— 旧文件名里含的是旧版本算出的摘要，
 * 新代码算出的摘要必然不同，旧文件于是变成孤儿并被常规清理扫掉。
 */
const PAYLOAD_KEY_VERSION = "p1";

/**
 * 载荷目录容量上限（字节）。
 *
 * 为什么需要上限：一张 scene 壁纸编码后能有 190MB（142MB 源 → 54MB 级别的 base64
 * 是常态，最大到过 190MB）。用户以后订阅多了壁纸，来回切换会把插件目录撑到几个 GB。
 * 这里按「上限 + 最久未访问优先淘汰」控制，既不会无限增长，也不会切一次删一次
 * 导致来回切换每次都重编码 54MB。
 */
const PAYLOAD_MAX_BYTES = 600 * 1024 * 1024;

/** 淘汰保护窗口：最近 5 分钟内写过的载荷不删（可能正被另一个窗口加载）。 */
const PAYLOAD_PROTECT_MS = 5 * 60 * 1000;

const VIDEO_EXTENSIONS = [".mp4", ".webm"];

/** child === parent 不算「在内部」；用于防止路径越界。 */
function isInside(parent, child) {
  try {
    const rel = path.relative(parent, child);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** realpath 的失败降级版：解析不了就退到 resolve，永不抛。 */
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

/**
 * 在壁纸目录里找 scene.pkg。
 * 必须是目录内部的真实文件：project.json 可能被别人改过，不能让它把路径指到别处。
 * 返回 { file, size, mtimeMs } 或 null。
 */
function findScenePkg(dir) {
  const realDir = safeRealpath(dir);
  if (!realDir) return null;
  const real = safeRealpath(path.join(realDir, "scene.pkg"));
  if (!real || !isInside(realDir, real)) return null;
  try {
    const stats = fs.statSync(real);
    if (!stats.isFile()) return null;
    return { file: real, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * 找视频壁纸的主视频文件。
 * 优先 project.json 的 file 字段；没有就挑目录里最大的 mp4/webm。
 * 返回 { file, size, mtimeMs } 或 null。
 */
function findVideoFile(dir, project) {
  const realDir = safeRealpath(dir);
  if (!realDir) return null;

  const tryFile = (name) => {
    if (typeof name !== "string" || !name.trim()) return null;
    const real = safeRealpath(path.join(realDir, name));
    if (!real || !isInside(realDir, real)) return null;
    if (!VIDEO_EXTENSIONS.includes(path.extname(real).toLowerCase())) return null;
    try {
      const stats = fs.statSync(real);
      if (!stats.isFile()) return null;
      return { file: real, size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
      return null;
    }
  };

  const preferred = tryFile(project && typeof project.file === "string" ? project.file : "");
  if (preferred) return preferred;

  let best = null;
  try {
    for (const dirent of fs.readdirSync(realDir, { withFileTypes: true })) {
      if (!dirent.isFile()) continue;
      if (!VIDEO_EXTENSIONS.includes(path.extname(dirent.name).toLowerCase())) continue;
      const hit = tryFile(dirent.name);
      if (!hit) continue;
      if (!best || hit.size > best.size) best = hit;
    }
  } catch {
    // 目录读不了就当没有视频。
  }
  return best;
}

/** 载荷目录绝对路径。 */
function payloadDir(pluginDir) {
  return path.join(pluginDir, PAYLOAD_DIR_NAME);
}

/**
 * 载荷缓存 key：由「壁纸 id + 源文件绝对路径 + 大小 + 修改时间 + 生成器版本」算出摘要。
 *
 * 为什么不用 `pkg-<id>.js` 这种固定名：固定名必须靠「校验内容对不对」来保证正确，
 * 而一旦 Steam 更新了壁纸、或写盘写到一半断电，光是大小碰巧相等就会把旧内容/半个文件
 * 当成有效缓存塞进引擎 —— 前者画面不对，后者直接崩。
 *
 * 改成摘要名之后，缓存的有效性变成了**文件名的一部分**：
 *   · 源文件被更新 → mtime/size 变 → key 变 → 文件名变 → 旧缓存自然成为孤儿
 *   · 生成逻辑升级 → bump PAYLOAD_KEY_VERSION → 全部旧缓存失配 → 被常规清理扫掉
 * 于是完全不需要「校验」这个动作，也没有 142MB 的信任问题。
 *
 * 做法借鉴 DSH 原项目的 lib/media/video-preview.js:124-131 与 lib/mp4-vfs.js:283。
 */
function payloadKey(spec) {
  return createHash("sha256")
    .update(String(spec.id || ""))
    .update("\0")
    .update(String(spec.source || ""))
    .update("\0")
    .update(String(Number(spec.size) || 0))
    .update("\0")
    .update(String(Math.round(Number(spec.mtimeMs) || 0)))
    .update("\0")
    .update(PAYLOAD_KEY_VERSION)
    .digest("hex")
    .slice(0, 20);
}

/**
 * 载荷文件名：前缀只用于「按类型清理时精确匹配」，真正区分内容的是摘要。
 * 摘要本身是纯 hex，天然不含路径分隔符，不需要再过滤。
 */
function payloadName(kind, key) {
  const prefix = PAYLOAD_PREFIXES[kind] || PAYLOAD_PREFIXES.scene;
  return `${prefix}${String(key).replace(/[^a-f0-9]/g, "")}${PAYLOAD_SUFFIX}`;
}

/** base64 输出长度：每 3 字节变 4 个字符，向上取整。 */
function base64Length(byteLength) {
  return 4 * Math.ceil(byteLength / 3);
}

/**
 * 载荷文件的开头：写一个全局对象，渲染端 <script> 一加载就能拿到。
 *
 * 为什么用 base64 而不是别的：脚本必须是纯文本；base64 的 4/3 膨胀（40MB → 54MB）
 * 换来的是 Chromium 自己流式读盘 + 原生 atob（本机 42MB 解码 134ms），
 * 比任何走 IPC 的方案都快两个数量级。
 *
 * 这里故意不用 JSON.stringify(整个对象)：那会为 54MB 字符串再复制一份，
 * 峰值内存翻倍。手工拼接 + 分块写盘可以压到只多一份 base64 分片。
 */
function payloadHeader(id, kind) {
  return (
    "// 由 Wallpaper Engine 插件在运行时自动生成，可随时删除。\n" +
    'window.__PIWE_ASSET = {"id":' +
    JSON.stringify(String(id)) +
    ',"kind":' +
    JSON.stringify(String(kind)) +
    ',"b64":"'
  );
}

const PAYLOAD_FOOTER = '"};' + "\n";

/**
 * 载荷文件应当有多大：头 + base64 长度 + 尾。
 * 只依赖「源文件字节数」，不需要真的读文件内容 ⇒ 判缓存是否有效时零拷贝。
 */
function payloadFileSize(kind, id, byteLength) {
  return Buffer.byteLength(payloadHeader(id, kind), "utf8")
    + base64Length(Number(byteLength) || 0)
    + Buffer.byteLength(PAYLOAD_FOOTER, "utf8");
}

/** 临时文件名带上自己的 PID，启动清扫时才能安全跳过「自己正在写的那个」。 */
function tempNameFor(file) {
  return `${file}.tmp-${process.pid}`;
}

/**
 * 判断一个文件是不是本插件生成的载荷（含它的临时文件）。
 * 只认自己的前缀 + .js 后缀，绝不误删用户放进来的东西。
 */
function isPayloadName(name) {
  const prefixes = Object.values(PAYLOAD_PREFIXES);
  if (!prefixes.some((prefix) => name.startsWith(prefix))) return false;
  return name.endsWith(PAYLOAD_SUFFIX) || name.includes(`${PAYLOAD_SUFFIX}.tmp`);
}

/**
 * 校验 PKGV 魔数：只读开头 16 字节。
 *
 * 为什么要单独做：源包有 142MB，为了确认「它是个场景包」而整读一遍太浪费。
 * 非 PKGV 的文件（比如用户手动塞的 exe）不该白编 190MB 载荷。
 */
function hasPkgvMagic(file) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    if (read < 8) return false;
    return buf.toString("latin1", 4, 8) === "PKGV";
  } catch {
    return false;
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        // 忽略。
      }
    }
  }
}

/**
 * 只做「算名字 + 看文件在不在」，**不读源文件内容**。
 *
 * 这是重复加载快的关键：以前每次切换壁纸都要把 106MB 的 scene.pkg 整个读进内存，
 * 只为让 ensurePayload 比一下大小。改成摘要命名后，大小与修改时间都从 stat 拿，
 * 命中缓存时一次 readFileSync 都不需要（~1ms 完成）。
 *
 * 返回 null 表示源文件不可用（不存在/不是文件）。
 */
function payloadInfo(pluginDir, spec) {
  const source = safeRealpath(spec && spec.source) || String((spec && spec.source) || "");
  if (!source) return null;
  let stats;
  try {
    stats = fs.statSync(source);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  const id = String((spec && spec.id) || "");
  const kind = spec && PAYLOAD_PREFIXES[spec.kind] ? spec.kind : "scene";
  const base = {
    id,
    kind,
    source,
    /** size 与 bytes 是同一个值：size 给 payloadKey 用，bytes 给调用方读。 */
    size: stats.size,
    bytes: stats.size,
    mtimeMs: stats.mtimeMs,
  };
  const key = payloadKey(base);
  const name = payloadName(kind, key);
  const file = path.join(payloadDir(pluginDir), name);
  const expected = payloadFileSize(kind, id, stats.size);

  let exists = false;
  try {
    const stat = fs.statSync(file);
    exists = stat.isFile() && stat.size === expected;
  } catch {
    exists = false;
  }

  return {
    ...base,
    key,
    name,
    file,
    rel: `${PAYLOAD_DIR_NAME}/${name}`,
    expected,
    exists,
  };
}

/**
 * 确保载荷文件存在。
 *
 * 两级策略：
 *   1. 名字（摘要）已经存在且大小正确 → 直接复用，**完全不读源文件**。
 *   2. 否则才整读源文件，分块编码写盘（先写 .tmp 再 rename，中途断电不会留下半个脚本文）。
 *
 * 返回 { rel, name, key, bytes, created }；rel 是相对插件目录的路径，渲染端自己拼协议前缀。
 */
function ensurePayload(pluginDir, spec) {
  let plan = payloadInfo(pluginDir, spec);
  if (!plan) throw new Error("source_unreadable");
  if (plan.exists) {
    return { rel: plan.rel, name: plan.name, key: plan.key, bytes: plan.bytes, created: false };
  }

  const data = fs.readFileSync(plan.source);
  if (!data.length) throw new Error("empty_source");

  // 源文件在两次 stat 之间被改过（Steam 正在更新）：按新大小与当前 mtime 重算名字，
  // 否则会写出一个「文件名里的摘要与实际内容不符」的载荷。
  if (data.length !== plan.bytes) {
    const fresh = payloadInfo(pluginDir, { ...spec, id: plan.id, kind: plan.kind, source: plan.source });
    plan = fresh || plan;
    plan.bytes = data.length;
    plan.expected = payloadFileSize(plan.kind, plan.id, data.length);
    plan.file = path.join(payloadDir(pluginDir), plan.name);
    plan.rel = `${PAYLOAD_DIR_NAME}/${plan.name}`;
  }

  const dir = payloadDir(pluginDir);
  fs.mkdirSync(dir, { recursive: true });

  // 先写临时文件再改名：中途失败不会留下半个载荷被浏览器当成完整脚本执行。
  const tmp = tempNameFor(plan.file);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, payloadHeader(plan.id, plan.kind));
    // 分块编码：每块字节数必须是 3 的整数倍，base64 分片才能直接拼接。
    const STEP = 3 * 1024 * 1024;
    for (let offset = 0; offset < data.length; offset += STEP) {
      const end = Math.min(offset + STEP, data.length);
      fs.writeSync(fd, data.subarray(offset, end).toString("base64"));
    }
    fs.writeSync(fd, PAYLOAD_FOOTER);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 关闭失败交给后面的 rename 报错。
    }
  }
  try {
    fs.renameSync(tmp, plan.file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略。
    }
    throw error;
  }

  return { rel: plan.rel, name: plan.name, key: plan.key, bytes: data.length, created: true };
}

/**
 * 删除孤儿临时文件：只删 `*.js.tmp-<pid>` 且 pid 不是自己。
 *
 * 为什么需要：编码 190MB 的过程中插件被禁用/宿主崩溃，会留下 .tmp。
 * 这些文件永远用不上，却占着几十上百 MB。启动时清一次最省事。
 */
function sweepPayloadTemp(pluginDir) {
  const removed = [];
  const dir = payloadDir(pluginDir);
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  const own = `.tmp-${process.pid}`;
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (!isPayloadName(dirent.name)) continue;
    if (!dirent.name.includes(`${PAYLOAD_SUFFIX}.tmp`)) continue;
    if (dirent.name.endsWith(own)) continue; // 自己正在写的那个
    try {
      fs.unlinkSync(path.join(dir, dirent.name));
      removed.push(`${PAYLOAD_DIR_NAME}/${dirent.name}`);
    } catch {
      // 删不掉就留着，下次启动再清。
    }
  }
  return removed;
}


/**
 * 清理旧版（v4 早期）遗留的载荷：`pkg-<纯数字 id>.js`。
 *
 * 为什么需要单独做：早期版本用「固定 id 命名」，改成摘要命名后这些文件
 * 既不会被复用（名字对不上），也不会被容量淘汰选中（用户壁纸少、总量没超上限），
 * 于是会永久占着几十上百 MB。启动时扫一次最省事。
 *
 * 判据很窄：前缀匹配 + 中间全是数字 + .js 结尾。摘要名是 hex 且长 20 位，
 * 正常情况下不会撞上；即便真撞上，也只是删掉一个会自动重建的缓存。
 */
function sweepLegacyPayloads(pluginDir) {
  const removed = [];
  const dir = payloadDir(pluginDir);
  const legacy = /^(pkg|vid|img)-\d+\.js$/;
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (!legacy.test(dirent.name)) continue;
    try {
      fs.unlinkSync(path.join(dir, dirent.name));
      removed.push(`${PAYLOAD_DIR_NAME}/${dirent.name}`);
    } catch {
      // 删不掉就留着，下次启动再清。
    }
  }
  return removed;
}

/**
 * 按容量上限淘汰载荷：超了就从「最久没写过的」开始删。
 *
 * 与「切换成功后删光其它」相比，这样来回切换不会每次重编码 54MB。
 * 三条保险（借鉴 DSH 的 lib/media/video-preview.js:93-120）：
 *   · keepRel 指定的文件（当前正在显示的）不删
 *   · 最近 5 分钟内写过的文件不删（另一个窗口可能正在加载）
 *   · 目录里最新的那个永远不删，避免把缓存删成空目录、下次又要重编码
 */
function prunePayloads(pluginDir, keepRel, maxBytes) {
  const keep = new Set(Array.isArray(keepRel) ? keepRel : keepRel ? [keepRel] : []);
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : PAYLOAD_MAX_BYTES;
  const dir = payloadDir(pluginDir);
  const removed = [];

  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed, usage: { count: 0, bytes: 0 } };
  }

  /** @type {{rel:string,file:string,bytes:number,mtimeMs:number}[]} */
  const entries = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (!isPayloadName(dirent.name)) continue;
    // 临时文件不参与容量统计，交给 sweepPayloadTemp 处理。
    if (dirent.name.includes(`${PAYLOAD_SUFFIX}.tmp`)) continue;
    const file = path.join(dir, dirent.name);
    try {
      const stats = fs.statSync(file);
      if (!stats.isFile()) continue;
      entries.push({ rel: `${PAYLOAD_DIR_NAME}/${dirent.name}`, file, bytes: stats.size, mtimeMs: stats.mtimeMs });
    } catch {
      // 忽略。
    }
  }

  let total = entries.reduce((sum, item) => sum + item.bytes, 0);
  if (total <= limit) {
    return { removed, usage: { count: entries.length, bytes: total } };
  }

  // 最久未写的排前面；最新的那个留到最后（索引 0 是最新的，所以从尾部开始删）。
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const now = Date.now();
  for (let i = entries.length - 1; i >= 0 && total > limit; i -= 1) {
    const item = entries[i];
    if (keep.has(item.rel)) continue;
    if (now - item.mtimeMs < PAYLOAD_PROTECT_MS) continue;
    // 最新那个永不删。
    if (i === 0) continue;
    try {
      fs.unlinkSync(item.file);
      total -= item.bytes;
      removed.push(item.rel);
    } catch {
      // 删不掉就跳过，下次再试。
    }
  }

  return { removed, usage: { count: entries.length - removed.length, bytes: total } };
}

/** 目录占用的总字节数，用于诊断展示。 */
function payloadUsage(pluginDir) {
  const dir = payloadDir(pluginDir);
  let total = 0;
  let count = 0;
  try {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!dirent.isFile()) continue;
      if (!isPayloadName(dirent.name)) continue;
      try {
        total += fs.statSync(path.join(dir, dirent.name)).size;
        count += 1;
      } catch {
        // 忽略。
      }
    }
  } catch {
    // 目录不存在就是 0。
  }
  return { count, bytes: total };
}

/**
 * 给渲染端用的资产描述：由 main 组装，渲染端据此决定「真渲染 / 真播放 / 静态图」。
 * 这里只保留与载荷相关的部分，方便测试复用。
 */
function describePayload(entry) {
  if (!entry || typeof entry !== "object") return null;
  const kind = entry.liveKind === "scene" || entry.liveKind === "video" || entry.liveKind === "image"
    ? entry.liveKind
    : "";
  if (!kind) return null;
  const isImage = kind === "image";
  return {
    id: String(entry.id || ""),
    kind,
    /** 原始文件绝对路径（main 内部用，不外发）。 */
    source: kind === "scene" ? entry.pkgPath || "" : isImage ? entry.assetPath || "" : entry.videoPath || "",
    bytes: kind === "scene"
      ? Number(entry.pkgSize) || 0
      : isImage
        ? Number(entry.size) || 0
        : Number(entry.videoSize) || 0,
    mtimeMs: kind === "scene"
      ? Number(entry.pkgMtimeMs) || 0
      : isImage
        ? Number(entry.assetMtimeMs) || 0
        : Number(entry.videoMtimeMs) || 0,
  };
}

module.exports = {
  PAYLOAD_DIR_NAME,
  PAYLOAD_PREFIXES,
  PAYLOAD_SUFFIX,
  PAYLOAD_KEY_VERSION,
  PAYLOAD_MAX_BYTES,
  PAYLOAD_PROTECT_MS,
  describePayload,
  VIDEO_EXTENSIONS,
  isInside,
  safeRealpath,
  findScenePkg,
  findVideoFile,
  payloadName,
  payloadKey,
  base64Length,
  payloadHeader,
  payloadFileSize,
  hasPkgvMagic,
  payloadInfo,
  ensurePayload,
  isPayloadName,
  sweepPayloadTemp,
  prunePayloads,
  sweepLegacyPayloads,
  payloadUsage,
};
