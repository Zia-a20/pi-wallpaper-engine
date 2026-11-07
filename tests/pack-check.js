// CI 用：校验仓库里声明的入口文件都在，且 manifest 自洽。
// 不读壁纸库、不碰 payload，可在任何机器上跑。
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const problems = [];

function must(rel, label) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) problems.push(`${label} 缺失: ${rel}`);
  else return fs.statSync(p).size;
  return 0;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

// 1) id 必须符合宿主的 PLUGIN_ID_PATTERN
const ID_RE = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
if (!ID_RE.test(manifest.id)) problems.push(`manifest.id 不合规: ${manifest.id}`);

// 2) 版本号必须能用于文件名
if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(manifest.version)) {
  problems.push(`manifest.version 不能用于文件名: ${manifest.version}`);
}

// 3) 声明的入口文件必须存在
must(manifest.main, "manifest.main");
if (manifest.renderer) must(manifest.renderer, "manifest.renderer");
if (manifest.ui && manifest.ui.panel) must(manifest.ui.panel, "ui.panel");

// 4) 第三方引擎与它的许可证必须同时存在（MIT 再分发条件）
const vendorJs = must("vendor/webwallgl.global.min.js", "vendor 引擎");
must("vendor/LICENSE-webwallgl.txt", "vendor 许可证");
must("LICENSE", "项目许可证");

// 5) payload 绝不能进仓库
const payloadDir = path.join(ROOT, "payload");
if (fs.existsSync(payloadDir)) {
  const files = fs.readdirSync(payloadDir);
  if (files.length) {
    problems.push(`payload/ 里有 ${files.length} 个文件：壁纸素材不得进版本库（见 .gitignore）`);
  }
}

// 6) 关键源码行数兜底，防止文件被意外清空
for (const f of ["main.js", "wallpaper-source.js", "renderer/index.mjs"]) {
  const size = must(f, "源码");
  if (size && size < 1000) problems.push(`${f} 体积异常小: ${size}B`);
}

console.log("--- pack-check ---");
console.log(`id      : ${manifest.id}`);
console.log(`version : ${manifest.version}`);
console.log(`vendor  : ${(vendorJs / 1024 / 1024).toFixed(2)} MB`);

if (problems.length) {
  console.log("PACK_CHECK_FAILED");
  problems.forEach((p) => console.log("  ! " + p));
  process.exit(1);
}
console.log("PACK_CHECK_OK");
