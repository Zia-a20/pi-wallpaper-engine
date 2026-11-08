# Wallpaper Engine 动态背景（PI-Desktop 插件）

把本机 Wallpaper Engine 的壁纸作为 PI 主界面的背景，让工作界面背后透出你订阅的动态画面。
侧栏、顶栏和输入框会做成半透明玻璃，文字区域加一层可控的压暗，保证可读性。

插件 id：`io.github.zia-a20.wallpaper-engine`

> **一句话**：把你本机 Wallpaper Engine 正在用的那张壁纸，变成 PI-Desktop 主界面的
> 实时动态背景 —— 同一个画面、会动、保持原分辨率。
>
> **不是什么**：
>
> - 不自带壁纸。它只读你本机已有的文件，不下载、不内置任何素材。
> - 不是预览图轮播。`scene` 类壁纸是真的把 `scene.pkg` 交给 WebGL 实时渲染。
> - 不联网。没有任何一处 `fetch`／上传逻辑，也不申请网络权限。
>
> **三个前提**：仅 Windows ｜ 已购买并安装 Wallpaper Engine（Steam `431960`）｜
> 同意 `renderer.extension` 权限（装的时候会弹一次原生授权框）。
>
> **安装**：到 [Releases](../../releases) 下载 `.piplug`，然后在
> PI-Desktop → 设置 → 插件 → 「从文件安装」选中它。

## 功能

- **自动发现壁纸库**：读注册表 `HKCU\Software\Valve\Steam\SteamPath`，再解析
  `libraryfolders.vdf` 里所有库路径，最后用常见安装位置兜底。不硬编码任何盘符。
- **同时收录两类壁纸**：创意工坊订阅（`steamapps/workshop/content/431960/*`）
  与本地工程（`steamapps/common/wallpaper_engine/projects/*`）。
- **和 WE 里看到的是同一个画面，而且是活的**：
  - `scene` 类：把 `scene.pkg` 整个喂给 WebGL 引擎（`vendor/webwallgl.global.min.js`）
    实时合成，24fps 持续渲染（`SCENE_FPS`，比 60 帧省得多，见下文省电一节），分辨率和 WE 一致；
  - `video` 类：把 mp4 原文件解成 Blob 直接 `<video loop muted autoplay>` 播放；
  - `web` 类：用网页里的大图原图（实测 3840×2160）。
- **可读性优先**：压暗强度、玻璃不透明度、背景模糊三个滑杆实时生效，设置自动保存到
  `~/.pi-wallpaper-engine/config.json`。
- **一键开关**：关掉后界面完全恢复 PI 原生外观，不留任何痕迹。

## 系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | **仅 Windows**。壁纸库发现依赖注册表 `HKCU\Software\Valve\Steam` 与 `libraryfolders.vdf` 的 Windows 路径格式，macOS / Linux 未适配。 |
| PI-Desktop | 已安装，且版本支持插件的 `renderer.extension` 权限与 `plugin-renderer:` 协议。 |
| Wallpaper Engine | **必须已购买并安装**（Steam AppID `431960`），并在创意工坊订阅过至少一张壁纸，或本地存有工程。 |

**这个插件不自带任何壁纸。** 它的作用是把你自己库里已有的壁纸搬进 PI 主界面 ——
画面和你在 Wallpaper Engine 里看到的是同一份，因为读的就是本机那些文件。
壁纸素材受版权保护，无法随插件分发。

如果没装 Wallpaper Engine，插件仍能安装并启用，但壁纸列表会是空的，
命令面板会提示：

> 没有发现壁纸库，请确认 Wallpaper Engine 已安装并订阅过壁纸

装好后建议先跑一次 `Wallpaper Engine: 查看壁纸库状态`，它会列出发现到的
Steam 库根目录与命中数量，便于排查。

### 关于权限

安装时唯一申请的权限是 **`renderer.extension`**。它在宿主的定义里属于高风险权限，
所以每次安装都会弹出原生授权框，需要你手动同意。

申请它的原因是：插件需要在 PI 主窗口的 `document.body` 上挂一层全屏背景舞台，
并把界面各层设为透明。拿不到主窗口的渲染上下文就无法实现。

**除此之外不申请任何其它权限**：没有 `net.fetch`，没有 `fs.write`，没有 `agent.*`。
代码里没有任何联网调用，也不上传任何数据 —— 所有素材只在本机读取、本机渲染。

## 安装

1. 在 [Releases](../../releases) 里下载最新版的
   `io.github.zia-a20.wallpaper-engine-<版本>.piplug`。
2. 打开 PI-Desktop → 设置 → 插件 → 「从文件安装」，选中刚下载的文件。
3. 安装时会请求 **renderer.extension** 权限（高风险，用途见上文「关于权限」），
   需要你手动同意。
4. 装好后点右下角的圆角小按钮 `◨` 打开设置面板，选中一张壁纸即可。

也可以装完直接用命令面板运行 `Wallpaper Engine: 查看壁纸库状态` 检查发现结果。

想自己从源码构建：`PluginPack` 会把当前目录打成 `dist/<id>-<版本>.piplug`，
打包前请确认 `payload/` 是空的（它不进包，`PluginPack` 也不会带上它）。

## 使用

右下角 `◨` 按钮 → 面板里：

| 控件 | 说明 |
| --- | --- |
| 启用壁纸背景 | 总开关。关掉即恢复原生外观。 |
| 壁纸列表 | 点任意一项立即应用。标签显示类型与真画面体积。 |
| 画面压暗 | 0–95%，跟随当前主题取色，浅色主题下不会把深色文字压花。 |
| 玻璃不透明度 | 侧栏与输入框的底色浓度。 |
| 背景模糊 | 玻璃后面的模糊半径 0–40px。 |
| 重新扫描 | 装了新壁纸之后用。列表按标题排序（中文按拼音、数字按大小），扫描结果与重启后一致。 |
| 清除背景 | 取消选中并释放已加载的画面与临时文件。 |

## 实现原理（为什么能高清又能动）

PI-Desktop 的主窗口是沙箱化的 `file://` 页面，CSP 是
`connect-src 'self'`，插件拿不到本地文件句柄，也不能 `fetch` 自定义协议。所以不能像
DSH 那样起一个本地 HTTP 服务再塞 iframe。

这里走的是宿主专门为插件保留的另一条通道：

1. **引擎脚本**：`<script src="plugin-renderer://<id>/g<N>/vendor/webwallgl.global.min.js">`
   由宿主以 `text/javascript` 直接分发（`plugin-renderer:` 白名单只放 js/mjs/css/json/map）。
   拿到 `window.WebWallGL`。
2. **二进制载荷**：插件 Node 进程把 `scene.pkg` / mp4 / 大图读出来，base64 编码成
   一个「会赋值 `window.__PIWE_ASSET` 的脚本」，写进插件目录下的
  `payload/{pkg|vid|img}-<sha256 前 20 位>.js`，再用 `<script>` 加载。
   Chromium 流式加载 42MB 只要约 0.6 秒，且**完全不走 IPC**——
   宿主的 `plugin.call` 限速 10 QPS、单次请求+响应合计 64KB，42MB 要 90 秒以上，不可用。
3. **渲染**：`scene` 交给 `WebWallGL.createScene()` + `bytesSource(bytes)`；
   `video` / `image` 用 `URL.createObjectURL` 造 Blob。
4. **回落**：任何一步失败（引擎报错、非 PKGV、I/O 失败）都会回落到 `preview.gif`
   的分块通道，保证不会白屏。

首帧实测：42MB scene 约 1.8 秒（载荷 0.57s + 解码 0.13s + 引擎装配 1.1s）。

### 载荷缓存

- 位置：`<插件安装目录>/payload/`，运行时生成，不进 `.piplug` 包。
- 体积：约等于壁纸素材 × 1.333（base64），单张最大实测 142MB（一张 106MB 的 scene.pkg）。
- **文件名就是内容摘要**：`<pkg|vid|img>-<sha256 前 20 位>.js`，摘要取自
  「壁纸 id + 源文件绝对路径 + 大小 + 修改时间 + 生成器版本号」。好处是不需要「校验」：
  Steam 更新壁纸 → mtime/size 变 → 摘要变 → 旧文件自然成为孤儿；
  生成逻辑升级 → bump `PAYLOAD_KEY_VERSION` → 全量失配。
- **命中缓存时完全不读源文件**：只 `stat` 源文件算出名字，文件已存在就直接复用
  （实测 0–1ms；旧做法每次都要把 106MB 的 pkg 整读一遍，100–300ms）。
- **容量上限 600MB + 最久未写优先淘汰**（`PAYLOAD_MAX_BYTES`）：超限时从 mtime
  最旧的开始删，三条保险 —— 当前正在显示的、最近 5 分钟内写过的、目录里最新那个都不删。
  这样来回切换不会每次重编码 54MB。
- **启动清扫**：`onLoad` 后延迟 3 秒做三件小事 —— 清孤儿临时文件（`*.js.tmp-<pid>`，
  排除自己的 PID）、清旧版按固定 id 命名的残留（`pkg-1234567890.js` 这类，新算法
  永不命中所以留着纯占空间）、按上限淘汰一次。编码中崩溃/断电留下的 `.tmp`
  不会长期占空间，从老版本升级上来也不会白占几十 MB。
- 每次生成新载荷后也会顺手淘汰一次；`assets.cleanup` 保留下来供排障和手动清理，
  返回 `{ok, removed, swept, legacy, limitBytes}`。

### 省电：遮挡降级

桌面壁纸引擎的 GPU 占用常年接近 0，关键不是渲染得多快，而是**看不见的时候不画**。
浏览器拿不到窗口遮挡状态，这里用两个最接近的代理信号：

| 状态 | 判定 | 场景类 | 视频类 |
| --- | --- | --- | --- |
| 前台 | 默认 | 24 fps | 播放 |
| 失焦（别的窗口盖住） | `window blur` | 降到 6 fps | 暂停 |
| 最小化 / 切走 | `document.hidden` | 暂停渲染循环 | 暂停 |

两个信号都带去抖（120ms），避免拖动窗口、快速 Alt-Tab 时反复暂停/恢复。
实测最小化后 GPU 与功耗回到接近空闲的水平。场景帧率 `SCENE_FPS = 24` 也是为此
（背景不需要 60 帧，24 帧比 30 帧再省约两成）。

## 已知限制

- **只在主窗口生效**，不影响设置页等其它窗口。
- **`scene` 首次编码有 1–2 秒延迟**：要整读 `scene.pkg` 并按 3MB 分块编码成 base64，
  106MB 的包约需 190MB 瞬时内存。写盘完成后即释放；之后复用缓存（0–1ms）。
- **`scene` 里的视频纹理/超长音频**未做音量控制，统一静音（`volume: 0`）。
- **不支持 `.web` 类壁纸的网页交互**：只取其背景大图，因为主窗口 CSP 不允许内嵌网页。
- **`video` 上限 300MB**：超过就回落 `preview.jpg` 静态图（`MAX_VIDEO_BYTES`）。
  正常 4K mp4 壁纸多在 5–60MB，300MB 留了足够余量。
- **内存峰值**：编码 106MB 的 scene.pkg 时会额外占约 190MB（base64 分块写盘，
  编完立刻释放）。这是首次生成载荷的瞬时开销，复用缓存时不再发生。

## 文件结构

```
main.js                      插件 Node 进程：Steam 发现 / 壁纸扫描 / 载荷编码 / 分块 RPC
wallpaper-source.js          壁纸库扫描与素材定位
renderer/index.mjs           主窗口：背景舞台 + 全局透明化样式 + 设置面板
vendor/webwallgl.global.min.js  WE scene.pkg 的 WebGL 渲染引擎（自包含单文件）
```

- 背景舞台 `#piwe-stage` 直接挂在 `document.body` 上，`position:fixed; z-index:-1`。
  不放 `openLayer()` 的容器里，因为 layer 在界面挂起时会被加 `hidden`。
- **不覆盖 `--ds-bg-primary`**：这个变量同时被当作按钮文字色使用，整体覆盖会让按钮文字消失。
  改为把 `html/body/#root/.app-shell/.main-pane/...` 的背景设为透明，让背景透出来。
- 全局透明规则写在自建 `<style id="piwe-theme-style">` 里。不能用
  `pi.ui.injectStyle`，因为它会把规则包进 `@scope ([data-pi-plugin="..."])`，
  作用不到 `html` / `body` 这些祖先节点。面板自身的样式才会走 `injectStyle`。
- RPC 方法：`settings.get` / `settings.set` / `library.list` / `library.scan` /
  `wallpaper.select` / `assets.meta` / `assets.chunk` / `assets.payload` / `assets.cleanup`。
- `assets.meta`、`assets.chunk`、`assets.payload` 都会校验 id 是否在扫描表内、
  素材 realpath 是否落在壁纸目录内，防止 `project.json` 把路径指向别处。

## 开发与测试

仓库自带 CI（GitHub Actions），推 PR 时自动跑：

```
node tests/pack-check.js        # manifest 自洽 / 入口文件存在 / payload 未混入
node tests/test-legacy.js       # 旧命名载荷清扫，不误删新命名
node tests/test-renderer.js     # 渲染层（DOM/引擎全桩）：加载、卸载、遮挡三档
node tests/test-startup-sweep.js# onLoad 后 3 秒启动清扫
node tests/test-unload-inflight.js # 卸载时仍有 in-flight 请求的竞态
```

这几个测试全部**不依赖本机壁纸库**，任何机器上都能跑。

依赖真实 Wallpaper Engine 的测试在 `tests/manual/`，需要手动跑：

| 脚本 | 依赖 |
| --- | --- |
| `test-main.js` | 本机已装 WE 并订阅过壁纸 |
| `test-payload.js` | 同上，且会真实读写上百 MB 载荷缓存 |
| `test-timeout.js` | 同上 |
| `test-debug-payload.js` | 排障用，输出载荷头尾，不是断言测试 |

本地跑全部：`node tests/pack-check.js` 之后依次执行 `tests/` 下四个脚本。

## 卸载

设置 → 插件 → 卸载。会自动移除背景层、注入的样式、blob URL，取消进行中的加载。
配置文件残留在 `~/.pi-wallpaper-engine/config.json`，载荷缓存在插件目录的
`payload/`（随插件目录一起删除），都可手动清理。
