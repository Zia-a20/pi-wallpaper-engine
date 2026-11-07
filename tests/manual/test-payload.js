// 验证 v4 载荷通道：assets.payload 为 scene / video / image 三类壁纸生成 .js 载荷，
// 并逐字节校验（大小、base64 可解、文件头魔数、清理只删自己的文件）。
// 生成物落在插件目录的 payload\ 下，跑完会调用 assets.cleanup 只留下当前选中项，
// 打包前务必确认 payload 目录已删除（见文件末尾提示）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PLUGIN_DIR = path.resolve(__dirname, "..", "..");
const PAYLOAD_DIR = path.join(PLUGIN_DIR, "payload");

globalThis.pi = {
  commands: { register: async () => {}, unregister: async () => {} },
  ui: { showToast: async () => {} },
  plugin: { getSettings: async () => ({}) },
  agent: { registerTool: async () => {} },
};

const plugin = require(path.join(PLUGIN_DIR, "main.js"));
const src = require(path.join(PLUGIN_DIR, "wallpaper-source.js"));

/** 从载荷脚本里把 base64 抠出来并解码；同时校验 id/kind 与预期一致。 */
function readPayload(rel, expectId, expectKind) {
  const file = path.join(PLUGIN_DIR, rel.split("/").join(path.sep));
  const text = fs.readFileSync(file, "utf8");
  const stats = fs.statSync(file);
  const head = 'window.__PIWE_ASSET = {"id":';
  if (!text.startsWith("//") || text.indexOf(head) < 0) throw new Error(`载荷头部格式不对：${rel}`);
  const idStart = text.indexOf(head) + head.length;
  const idEnd = text.indexOf(',"kind":', idStart);
  const gotId = JSON.parse(text.slice(idStart, idEnd));
  const kindStart = idEnd + ',"kind":'.length;
  const kindEnd = text.indexOf(',"b64":"', kindStart);
  const gotKind = JSON.parse(text.slice(kindStart, kindEnd));
  if (gotId !== expectId) throw new Error(`id 不符：${gotId} != ${expectId}`);
  if (gotKind !== expectKind) throw new Error(`kind 不符：${gotKind} != ${expectKind}`);

  const b64 = text.slice(kindEnd + ',"b64":"'.length, text.length - '"};'.length - 1);
  const bytes = Buffer.from(b64, "base64");
  // 预期文件大小 = 头 + base64 长度 + 尾。任何一项偏差都说明写盘逻辑有 bug。
  const expected = Buffer.byteLength(src.payloadHeader(expectId, expectKind), "utf8")
    + src.base64Length(bytes.length) + Buffer.byteLength('"};' + "\n", "utf8");
  if (stats.size !== expected) throw new Error(`载荷大小不符：${stats.size} != ${expected}（${rel}）`);
  return { bytes, size: stats.size, sha: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function magicOf(buffer) {
  if (buffer.length >= 8 && buffer.toString("latin1", 4, 8) === "PKGV") return "PKGV";
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "EBML/webm";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "JPEG";
  if (buffer.length >= 4 && buffer.toString("latin1", 1, 4) === "PNG") return "PNG";
  if (buffer.length >= 4 && buffer.toString("latin1", 0, 4) === "GIF8") return "GIF";
  if (buffer.length >= 12 && buffer.toString("latin1", 4, 8) === "ftyp") return "MP4";
  return "unknown";
}

(async () => {
  await plugin.onLoad();

  const list = await plugin.onRendererCall("library.list", {});
  if (!list.ok) throw new Error("library.list 失败");
  console.log(`壁纸 ${list.total} 张`);

  // 允许覆盖的载荷总量上限：本测试会真的写出 54MB × N，跑完必须清理。
  const seenKinds = new Set();
  // 摘要命名后文件名里不再含 id，记录每个 id 对应的 rel，供末尾比对「当前壁纸保住了」。
  const relById = new Map();
  for (const item of list.wallpapers) {
    const kindTag = item.liveKind || "(none)";
    const expectBytes = item.liveBytes;
    process.stdout.write(`\n[${item.id}] type=${item.type} liveKind=${kindTag} liveBytes=${expectBytes}\n`);

    const info = await plugin.onRendererCall("assets.payload", { id: item.id });
    if (!info.ok) {
      console.log(`  payload -> 拒绝 ${info.error}${info.bytes ? ` (${info.bytes}B)` : ""}`);
      // liveKind 为空的情况必须被拒绝，否则渲染端会拿到不存在的东西。
      if (item.liveKind) throw new Error(`${item.id} 有 liveKind 却拿不到载荷：${info.error}`);
      continue;
    }
    if (!item.liveKind) throw new Error(`${item.id} 没有 liveKind 却生成了载荷`);
    relById.set(String(info.id), info.rel);
    if (info.kind !== item.liveKind) throw new Error(`kind 不一致：${info.kind} != ${item.liveKind}`);
    seenKinds.add(info.kind);

    const t0 = Date.now();
    const got = readPayload(info.rel, info.id, info.kind);
    const ms = Date.now() - t0;
    if (got.bytes.length !== expectBytes) {
      throw new Error(`${item.id} 原始字节不符：${got.bytes.length} != ${expectBytes}`);
    }
    const magic = magicOf(got.bytes);
    console.log(`  payload ${info.rel} created=${info.created} b64file=${got.size}B raw=${got.bytes.length}B magic=${magic} verifyMs=${ms}`);
    console.log(`  sha256=${got.sha}`);
    console.log(`  mime=${info.mime} name=${info.name}`);

    const expectMagic = info.kind === "scene" ? "PKGV" : info.kind === "video" ? "MP4|EBML/webm" : "JPEG|PNG|GIF";
    if (!expectMagic.split("|").includes(magic)) throw new Error(`魔数不符：${magic} 期望 ${expectMagic}`);

    // 再调一次必须是复用（created=false），否则每次启动都要重写 54MB。
    const again = await plugin.onRendererCall("assets.payload", { id: item.id });
    if (!again.ok) throw new Error("二次调用失败");
    if (again.created) throw new Error(`${item.id} 没有复用载荷`);
    console.log("  复用 OK");
  }
  console.log(`\n覆盖类型：${[...seenKinds].join(", ") || "(无)"}`);

  // 越权与错误分支。
  console.log("unknown id ->", JSON.stringify(await plugin.onRendererCall("assets.payload", { id: "nope" })));
  console.log("empty id   ->", JSON.stringify(await plugin.onRendererCall("assets.payload", {})));
  console.log("no args    ->", JSON.stringify(await plugin.onRendererCall("assets.payload")));

  // 清理：只应删掉非当前选中项。测试里选中项是 config 里的那个。
  const before = await plugin.onRendererCall("settings.get", {});
  const selectedId = before && before.settings ? String(before.settings.selectedId || "") : "";
  const dirsBefore = fs.existsSync(PAYLOAD_DIR) ? fs.readdirSync(PAYLOAD_DIR).length : 0;
  const clean = await plugin.onRendererCall("assets.cleanup", {});
  const dirsAfter = fs.existsSync(PAYLOAD_DIR) ? fs.readdirSync(PAYLOAD_DIR).length : 0;
  console.log(`\ncleanup -> ok=${clean.ok} removed=${JSON.stringify(clean.removed)} usage=${JSON.stringify(clean.usage)}`);
  console.log(`payload 文件数 ${dirsBefore} -> ${dirsAfter}（选中 ${selectedId || "无"}）`);
  // 摘要命名之后，文件名里不再含 id，只能按「自己算出来的 rel」比对是否保住了当前壁纸。
  const keepRel = relById.get(selectedId) || "";
  const filesAfter = fs.existsSync(PAYLOAD_DIR) ? fs.readdirSync(PAYLOAD_DIR) : [];
  if (keepRel) {
    const keepName = keepRel.split("/").pop();
    if (!filesAfter.includes(keepName)) throw new Error(`当前壁纸的载荷被误删了：${keepName}`);
    console.log(`  当前壁纸载荷已保住：${keepName}`);
  }
  for (const name of filesAfter) {
    console.log(`  留下 ${name}${keepRel && name === keepRel.split("/").pop() ? " (当前壁纸)" : ""}`);
  }
  // 注：真实载荷目录里刚写入的文件都在 5 分钟保护窗口内，不会被淘汰，
  // 所以容量淘汰与临时文件清扫改用下面的独立临时目录验证。
  const tmpRoot = path.join(require("node:os").tmpdir(), `piwe-prune-${process.pid}`);
  const tmpPayload = path.join(tmpRoot, "payload");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpPayload, { recursive: true });
  const mk = (name, bytes, ageMs) => {
    const file = path.join(tmpPayload, name);
    fs.writeFileSync(file, Buffer.alloc(bytes, 0x41));
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    return file;
  };
  const oldA = mk("pkg-aaaaaaaaaaaaaaaaaaaa.js", 4096, 60 * 60 * 1000);
  const oldB = mk("vid-bbbbbbbbbbbbbbbbbbbb.js", 4096, 30 * 60 * 1000);
  const freshC = mk("pkg-cccccccccccccccccccc.js", 4096, 0);
  // 上限压到 4KB：只够留一个。最旧的先删，最新那个即使超限也不删。
  const tmpPrune = src.prunePayloads(tmpRoot, "", 4096);
  const tmpLeft = fs.readdirSync(tmpPayload).sort();
  console.log(`\n容量淘汰（临时目录）：removed=${JSON.stringify(tmpPrune.removed)} 剩余=${JSON.stringify(tmpLeft)}`);
  if (fs.existsSync(oldA)) throw new Error("最旧的载荷应被淘汰");
  if (fs.existsSync(oldB)) throw new Error("次旧的载荷应被淘汰");
  if (!fs.existsSync(freshC)) throw new Error("最新的载荷不该被删");
  // keepRel 必须生效：即使超限也不删指定的那个。
  const keptD = mk("pkg-dddddddddddddddddddd.js", 4096, 2 * 60 * 60 * 1000);
  src.prunePayloads(tmpRoot, "payload/pkg-dddddddddddddddddddd.js", 1024);
  if (!fs.existsSync(keptD)) throw new Error("keepRel 指定的载荷被误删");
  // 临时文件必须被 sweep 清掉，但不能动 .js 正式载荷。
  const staleTmp = path.join(tmpPayload, "pkg-eeeeeeeeeeeeeeeeeeee.js.tmp-999999");
  fs.writeFileSync(staleTmp, "x");
  const swept = src.sweepPayloadTemp(tmpRoot);
  console.log(`临时文件清扫：swept=${JSON.stringify(swept)}`);
  if (fs.existsSync(staleTmp)) throw new Error("孤儿临时文件没被清掉");
  if (!fs.existsSync(keptD)) throw new Error("清扫临时文件时误删了正式载荷");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const usageFinal = src.payloadUsage(PLUGIN_DIR);
  console.log(`真实载荷目录：count=${usageFinal.count} bytes=${usageFinal.bytes}（上限 ${src.PAYLOAD_MAX_BYTES}）`);

  await plugin.onUnload();
  console.log("\nPAYLOAD_TEST_OK");
  console.log(`提醒：打包前请删除 ${PAYLOAD_DIR}`);
})().catch((e) => {
  console.error("FAILED:", e && e.stack ? e.stack : e);
  process.exit(1);
});
