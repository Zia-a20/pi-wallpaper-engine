这个目录是测试用的假 HOME（`os.homedir()` 的替身）。

`test-renderer.js` 和 `test-unload-inflight.js` 会在运行时把
`.pi-wallpaper-engine/config.json`、载荷缓存、预览图写到这里，
内容是**本机真实 Wallpaper Engine 壁纸**的 id 和素材。

因此整个 `.pi-wallpaper-engine/` 子目录都写进了 `.gitignore`，
不要把它提交进版本库。

仓库里只保留这个说明文件。测试第一次运行时会自动建出配置文件。
