# dsh-pet Windows 使用说明

本目录是 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（DSH 桌面宠物）的
Windows 可运行版本：**已在真机 Windows 上完成构建、实跑与修复**。原代码声明三端兼容，
实测在本机（双 4K/2.5K 异构缩放屏环境）会被 Electron 的 GPU 子进程崩溃阻断
（详见文末「修复记录」）；本版本已修复并验证通过。

## 零、打包版（推荐）：双击 `dsh-pet.exe`

`dist/dsh-pet-win/` 是一个**自包含便携 App**，不需要 Node.js、不需要联网下载任何东西：

| 操作 | 方法 |
| --- | --- |
| 启动 | 双击 `dsh-pet.exe`（约 400MB 目录，首次启动 2~3 秒） |
| 停止 | 双击 `stop-pet.cmd`（走 `POST /shutdown`；也可用任务管理器结束 `dsh-pet.exe`） |
| 多开 | 再双击一次 `dsh-pet.exe`，第二只宠物用 3081 端口，互不干扰 |

架构（与"源码/独立模式"的根本区别）：宿主半边（路由表 / 配置聚合 / 状态仓 / 周期定时器）
**跑在 Electron 主进程内**（`DSH_PET_EMBED_HOST`），窗口渲染端经 `http://127.0.0.1:3080`
取配置与素材——单进程、无外部 Node、无 node_modules、无 bridge 管道。

打包命令（在包根执行）：

```bat
npm run build
npm run pack:win            :: 产出 dist/dsh-pet-win/dsh-pet.exe
```

需要先有已解压的 Electron（`npm run ensure:electron` 会放到 `%USERPROFILE%\.dsh\electron`）。
exe 图标/版本信息需要 `rcedit.exe`（可选，用 `DSH_PET_RCEDIT` 指定；没有就只生成
`dsh-pet.ico` 并跳过改写，不影响运行）。

## 一、源码运行（开发/调试用）

- **Node.js ≥ 22.12**（[nodejs.org](https://nodejs.org) 装 LTS 即可）。
- 首次运行会自动下载 Electron 43.3.0（约 170MB）到 `%USERPROFILE%\.dsh\electron\`，
  走 npmmirror 镜像，只下一次，之后离线可用。
- 无需安装 DSH（DeepSeek Harness）——独立模式运行。

## 二、启动 / 停止（源码模式）

| 操作 | 方法 |
| --- | --- |
| 启动桌宠 | 双击 **`start-pet.bat`** |
| 停止 | 双击 **`stop-pet.bat`**，或在启动窗口按 `Ctrl+C` |

启动后桌面上出现透明置顶小窗（蓝毛小女仆，默认右上角）：
左键拖动可甩抛，点击有回应动画，**右键**打开完整菜单（动作 / 余额 / 对话 / 多开配置等）。
启动窗口里的日志可观察运行状态；关掉启动窗口等于 `Ctrl+C`。

体检（不开窗，检查配置 / Electron / 显示环境）：

```bat
node lib\standalone.js --check
```

## 三、冒烟截图验证（可选）

```bat
set DSH_PET_SMOKE=1
set DSH_PET_SMOKE_OUT=%CD%\smoke.png
node lib\standalone.js
```

约 9 秒后 helper 自动截图到 `smoke.png` 并退出（可用本目录附带的
`smoke-auto.png` 对照预期效果）。打包版同样支持这套变量：

```bat
set DSH_PET_SMOKE=1
set DSH_PET_SMOKE_OUT=%CD%\smoke.png
dsh-pet.exe
```

## 四、配置与自定义素材

| 内容 | 位置 |
| --- | --- |
| 用户配置 | `%USERPROFILE%\.dsh\dsh-pet\main-config.jsonc`（不存在则用包内默认 `assets\config.jsonc`） |
| 自定义动画 | `%USERPROFILE%\.dsh\dsh-pet\main-animation\webm\`（.webm，文件名须与配置动画名一致） |
| 表情包 | 包内 `assets\memes\*.png` |
| 宠物大小/位置/多开 | 编辑 `main-config.jsonc` 的 `pets` 数组（`size` / `position.corner` / `display`） |

`display` 须为 `desktop` 或 `both` 才会出现桌面小窗。余额 / 碎碎念 / 对话 / 系统通知
依赖 DSH 的凭证与模型，独立模式下不可用（结构化报错，不影响其它功能）。

## 五、本项目的修复记录（相对上游 PC2005-cloud/dsh-pet@6abec90）

1. **构建**：`pnpm` 默认 isolated 链接器在本机 node_modules 顶层大量缺链
   （tsdown/typescript/react 等均未链上，`tsdown` 命令找不到）；改用
   `pnpm install --config.node-linker=hoisted` 后构建通过。
2. **运行（主阻断点）**：Windows 上 Electron 的 GPU 子进程以
   `0xC0000005`（访问违例）反复崩溃并令 helper 主进程 FATAL，桌宠陷入
   「拉起→崩溃→重启」永远无法显示。修复为自动降级机制：
   - `src/host/helper-process.ts`：检测崩溃签名（`GPU process exited unexpectedly` /
     `GPU process isn't usable`），累计 2 次后在重启时自动注入 `DSH_PET_DISABLE_GPU=2`；
   - `runtime/electron-helper/main.js`：该档位对应 Chromium `--in-process-gpu`
     （GPU 服务并入浏览器进程），实测此类环境零崩溃、渲染与冒烟截图正常；
   - **打包 App 默认就是档位 2**：内嵌模式下窗口进程就是 App 进程，GPU 崩溃会带走整个 App、
     没有宿主守护循环可救，所以默认规避（显式 `DSH_PET_FORCE_GPU=1` 可恢复原状）；
   - 排障通道：`DSH_PET_DISABLE_GPU=1/3`、`DSH_PET_FORCE_GPU=1`、`DSH_PET_EXTRA_SWITCHES`。
3. **打包（exe）**：新增 `src/standalone/app-host.ts`（内嵌宿主 CJS 入口）、
   `runtime/electron-helper/main.js` 的内嵌模式分支、`scripts/pack-win.mjs` 打包脚本与
   `runtime/win/stop-pet.{cmd,ps1}` 退出入口。要点：
   - 宿主半边与窗口进程**合并为单进程**，渲染端走 `127.0.0.1` HTTP（app-host 给每条路由补 CORS 头）；
   - tsdown 第四份配置把 `@electron/get` / `extract-zip` 也换成替身，产物**零 node_modules**；
   - `loadFile` 改绝对路径（相对路径按 `app.getAppPath()` 解析，打包后指向 `resources/app` 会 404）；
   - 打包 App 的应用名 `dsh-pet`（与 `resources/app/package.json` 的 name 一致，有守卫测试钉住）。
4. **单测**：新增 4 个用例覆盖降级纯函数与重启注入，另同步两处防漂移守卫
   （全套 658 项测试通过）。
5. **启动器**：新增 `start-pet.bat` / `stop-pet.bat` / `stop-pet.mjs`（源码模式）与
   `stop-pet.cmd` / `stop-pet.ps1`（打包模式，不依赖 Node），均已实测闭环。

验证截图：`smoke-auto.png`（源码模式）、`pack-smoke.png`（打包 exe，透明背景 + 动画 +
自绘右键菜单均正常，零 GPU 崩溃）。

## 六、从源码重新构建 / 打包

```bat
cd /d %USERPROFILE%\path\to\dsh-pet\dsh-pet
corepack pnpm install --config.node-linker=hoisted
npm run build          :: lib/ + shared-core.js + 类型声明
npm run pack:win       :: dist\dsh-pet-win\dsh-pet.exe（约 400MB，自包含）
```

上游仓库 README 的「Windows 排障」一节已同步本修复说明。
