# dsh-pet Windows 版

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**DSH 桌面宠物（dsh-pet）的 Windows 可运行衍生版**：修复了在本机 Windows 上必然触发的
Electron GPU 子进程崩溃，并新增**一键打包成免安装 `dsh-pet.exe`** 的能力。

> 上游项目：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT，作者 PC2005-cloud）
> 本仓库基于其 `main@6abec90` 快照，**保留了完整的 MIT 许可与版权声明**，改动逐项列在下方。
> 上游功能的完整文档见 [`UPSTREAM-README.md`](UPSTREAM-README.md)。

---

## 一句话结论

上游代码本身声明 Windows / macOS / Linux 三端兼容，且代码里确实有大量 win32 分支；但在一台
真实 Windows 机器（双屏 3840×2160@150% + 1440×2560）上实测，桌宠**永远出不来**——根因是
Electron 的 GPU 子进程以 `0xC0000005`（访问违例）反复崩溃并令主进程 FATAL。本仓库把它修好，
并顺手把"要装 Node、要联网下载 Electron"的门槛去掉：直接双击一个 exe 就能用。

---

## 快速开始

### 方式一：免安装 exe（推荐）

```bat
npm install                  :: 首次
npm run build                :: 构建 lib/ 与桌面共享核心
npm run pack:win             :: 产出 dist\dsh-pet-win\dsh-pet.exe
```

产物 `dist/dsh-pet-win/` 是一个**自包含便携 App**（约 400MB，含 Electron 运行时）：

| 操作 | 方法 |
| --- | --- |
| 启动 | 双击 `dsh-pet.exe`（无需 Node.js、无需联网） |
| 停止 | 双击 `stop-pet.cmd`，或任务管理器结束 `dsh-pet.exe` |
| 多开 | 再双击一次即可（第二只宠物自动用 3081 端口） |

宠物出现在桌面右上角：左键拖动可甩抛、点击有回应动画、**右键**打开完整菜单
（动作 / 余额 / 对话 / 多开配置等）。

### 方式二：源码运行（独立模式，不需要 DSH）

```bat
corepack pnpm install --config.node-linker=hoisted
npm run build
start-pet.bat                :: 启动；stop-pet.bat 停止
node lib\standalone.js --check   :: 只体检，不开窗
```

### 方式三：作为 DSH 插件使用

上游的插件形态（`dsh plugin add` / 浏览器 overlay / 设置页）**未做任何破坏性改动**，
按 [`UPSTREAM-README.md`](UPSTREAM-README.md) 的说明安装即可。

---

## 本仓库相对上游改了什么

| # | 问题（上游行为） | 本仓库的处理 |
| --- | --- | --- |
| 1 | **GPU 子进程崩溃**：`GPU process exited unexpectedly: exit_code=-1073741819` → 主进程 FATAL → 桌宠无限「拉起→崩溃→重启」，永远不可见 | 宿主侧识别崩溃签名，累计 2 次后自动带 `DSH_PET_DISABLE_GPU=2`（Chromium `--in-process-gpu`）重启；实测该环境零崩溃。排障通道：`DSH_PET_DISABLE_GPU=1/3`、`DSH_PET_FORCE_GPU=1`、`DSH_PET_EXTRA_SWITCHES` |
| 2 | 打包 App 里 GPU 崩溃会**带走整个进程**（两进程形态才有守护循环可救） | 打包版默认档位 2，开箱即用；`DSH_PET_FORCE_GPU=1` 可恢复原状 |
| 3 | **无法打包成 exe**：桌面形态是「Node 宿主 + Electron 窗口」两段式，打包器只认后者 | 新增内嵌宿主模式（`DSH_PET_EMBED_HOST`）：宿主半边跑进 Electron 主进程，渲染端走 `127.0.0.1` HTTP → **单进程**；`tsdown` 第四份配置把 `@electron/get` / `extract-zip` 换成替身，产物**零 node_modules** |
| 4 | `loadFile('index.html')` 用相对路径（按 `app.getAppPath()` 解析） | 改绝对路径，否则打包后页面 `ERR_FILE_NOT_FOUND` |
| 5 | 构建：pnpm 默认 isolated 链接器在 Windows 上顶层大面积静默缺链（`tsdown` 命令都找不到） | 文档给出 `--config.node-linker=hoisted`；新增 `npm run pack:win` |
| 6 | 无退出入口（打包后没有窗口关闭按钮） | 新增 `stop-pet.cmd` / `stop-pet.ps1`（不依赖 Node，走 `POST /shutdown`），`/shutdown` 在打包版里真正退出 App |
| 7 | — | 新增单测：GPU 降级纯函数与重启注入 4 例；同步两处防漂移守卫（**全套 658 项测试通过**） |

### 关键设计：内嵌宿主（单进程）

```
上游（DSH / 独立模式）                     本仓库打包版
┌──────────────┐  管道/HTTP  ┌───────────┐  ┌───────────────────────────────┐
│ Node 宿主半边 │ ──────────▶ │ Electron  │  │ dsh-pet.exe (Electron 主进程) │
│ 路由/配置/状态 │             │ 窗口进程   │  │  ├─ 宿主半边（app-host.cjs）   │
└──────────────┘             └───────────┘  │  └─ 窗口 + 渲染端              │
                                             │     经 127.0.0.1:3080 取数     │
                                             └───────────────────────────────┘
```

- 新增入口：`src/standalone/app-host.ts`（`startPetHost()` / `readDesktopPets()`），并给每条路由
  补 `Access-Control-Allow-Origin`（渲染端是 `file://` 源，跨源取数需要它）
- 窗口进程：`runtime/electron-helper/main.js` 的内嵌分支（`DSH_PET_EMBED_HOST=1`）
- 打包脚本：`scripts/pack-win.mjs`（Electron 发行版 + `resources/app`，`electron.exe` → `dsh-pet.exe`，
  可选 rcedit 写入图标与版本信息）

---

## 环境要求

- **Node.js ≥ 22.12**（源码运行 / 打包需要；用打包好的 exe 则不需要）
- Windows 10/11 x64（打包版实测于 Windows + 双屏异构缩放环境）
- 首次源码运行会自动下载 Electron 43.3.0（约 170MB，走 npmmirror）到
  `%USERPROFILE%\.dsh\electron\`；打包时会复用这份已解压的运行时

## 配置与自定义

| 内容 | 位置 |
| --- | --- |
| 用户配置 | `%USERPROFILE%\.dsh\dsh-pet\main-config.jsonc`（不存在则用包内默认） |
| 自定义动画 | `%USERPROFILE%\.dsh\dsh-pet\main-animation\webm\`（`.webm`，文件名与配置动画名一致） |
| 大小 / 位置 / 多开 | 配置里的 `pets[]`（`size` / `position` / `display`） |

`display` 需含 `desktop` 或 `both` 才会出现桌面小窗。完整字段说明见
[`dsh-pet/Windows使用说明.md`](dsh-pet/Windows使用说明.md) 与上游 README。

## 已知限制

- **余额 / 碎碎念 / 对话 / 系统通知**依赖 DSH 本体的凭证、模型与会话，在独立模式与打包版里
  不可用（返回结构化失败，不假装成功）。这是上游的设计边界，本仓库未改动。
- 打包版是**便携目录**而非安装包：拷走整个 `dist\dsh-pet-win\` 即可运行。
- 打包版在部分环境（RDP / 虚拟机 / 显卡驱动异常）依赖 `--in-process-gpu` 规避 GPU 崩溃；
  若你的机器 GPU 正常且想用原行为，设 `DSH_PET_FORCE_GPU=1`。

## 从源码重新构建 / 打包

```bat
corepack pnpm install --config.node-linker=hoisted
npm run build                 :: lib/ + shared-core.js + 类型声明
npm run pack:win              :: dist\dsh-pet-win\dsh-pet.exe
npm test                      :: 658 项单测
```

冒烟自检（截图验证窗口/渲染/菜单链路）：

```bat
set DSH_PET_SMOKE=1
set DSH_PET_SMOKE_OUT=%CD%\smoke.png
dsh-pet.exe
```

## 与上游同步

本仓库是**快照式衍生**（基于 `6abec90`），不是 fork 的持续追踪分支。上游若有新版本，
建议做法是把本仓库的改动逐个挑回：核心只有 6 个文件
（`src/standalone/app-host.ts`、`runtime/electron-helper/main.js`、`src/host/index.ts`、
`src/host/helper-process.ts`、`tsdown.config.mjs`、`scripts/pack-win.mjs`）加两个 shim。

## 许可与致谢

- 本项目沿用上游的 **MIT License**（见 [`LICENSE`](LICENSE)），版权归原作者 **PC2005-cloud** 所有。
- 素材（动画 webm / 表情包 / 字体）与设计均来自上游仓库，未做改动。
- 感谢上游作者做出这个桌宠；本仓库只做 Windows 可用性与打包层面的修补。
