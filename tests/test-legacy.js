// 验证：已安装目录里人为放一个旧命名载荷，assets.cleanup 能清掉它，且不误删新命名载荷。
const fs = require("fs");
const path = require("path");

const DIR = path.resolve(__dirname, "..");
const payloadDir = path.join(DIR, "payload");

// 1) 造两个旧名残留（一个 56MB 之类没意义，用小的即可）+ 一个"看起来像但不是"的反例
const legacyA = path.join(payloadDir, "pkg-1111111111.js");
const legacyB = path.join(payloadDir, "vid-2222222222.js");
// 反例：不是纯数字 id，不该被删（比如未来某种命名）
const keepName = path.join(payloadDir, "pkg-abc123def456.js");
// 新命名样例：20 位十六进制摘要，必须原样保留。测试自备，不依赖真实壁纸库，
// 这样在没有 Wallpaper Engine 的机器（以及 CI）上也能跑。
const newName = path.join(payloadDir, "pkg-0123456789abcdef0123.js");

fs.mkdirSync(payloadDir, { recursive: true });
fs.writeFileSync(legacyA, "LEGACY-A");
fs.writeFileSync(legacyB, "LEGACY-B");
if (!fs.existsSync(keepName)) fs.writeFileSync(keepName, "KEEP-ME");
if (!fs.existsSync(newName)) fs.writeFileSync(newName, "NEW-FORMAT");

const before = fs.readdirSync(payloadDir).sort();
console.log("注入前：", before.join(" | "));

const plugin = require(path.join(DIR, "main.js"));
(async () => {
  await plugin.onLoad({});
  const res = await plugin.onRendererCall("assets.cleanup", {});
  console.log("cleanup ->", JSON.stringify(res));

  const after = fs.readdirSync(payloadDir).sort();
  console.log("清理后：", after.join(" | "));

  const okLegacyA = !after.includes("pkg-1111111111.js");
  const okLegacyB = !after.includes("vid-2222222222.js");
  const okKeep = after.includes("pkg-abc123def456.js");
  const okReal = after.some((n) => /^pkg-[0-9a-f]{20}\.js$/.test(n));

  console.log(`${okLegacyA ? "PASS" : "FAIL"}  旧命名 pkg-<数字id>.js 已清理`);
  console.log(`${okLegacyB ? "PASS" : "FAIL"}  旧命名 vid-<数字id>.js 已清理`);
  console.log(`${okKeep ? "PASS" : "FAIL"}  非旧命名文件未被误删`);
  console.log(`${okReal ? "PASS" : "FAIL"}  新命名载荷仍然保留`);

  // 清掉本次注入的样例文件，不留痕迹
  try { fs.unlinkSync(keepName); } catch {}
  try { fs.unlinkSync(newName); } catch {}

  if (okLegacyA && okLegacyB && okKeep && okReal) console.log("LEGACY_TEST_OK");
  else { console.log("LEGACY_TEST_FAILED"); process.exit(1); }
})().catch((e) => {
  console.error("ERR", e && e.message);
  process.exit(1);
});
