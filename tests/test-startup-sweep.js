// 验证：onLoad 后约 3 秒的启动清扫，能自动清掉旧命名载荷。
const fs = require("fs");
const path = require("path");

const DIR = path.resolve(__dirname, "..");
const payloadDir = path.join(DIR, "payload");
const legacy = path.join(payloadDir, "img-333333333.js");

fs.mkdirSync(payloadDir, { recursive: true });
fs.writeFileSync(legacy, "LEGACY-STARTUP");
console.log("注入旧命名文件：", fs.existsSync(legacy));

const plugin = require(path.join(DIR, "main.js"));
(async () => {
  await plugin.onLoad({});
  console.log("onLoad 完成，等待启动清扫（3s + 余量）…");
  await new Promise((r) => setTimeout(r, 3600));
  const gone = !fs.existsSync(legacy);
  console.log(`${gone ? "PASS" : "FAIL"}  启动清扫自动清掉 img-333333333.js`);
  await plugin.onUnload();
  console.log(gone ? "STARTUP_SWEEP_OK" : "STARTUP_SWEEP_FAILED");
  process.exit(gone ? 0 : 1);
})().catch((e) => {
  console.error("ERR", e && e.message);
  process.exit(1);
});
