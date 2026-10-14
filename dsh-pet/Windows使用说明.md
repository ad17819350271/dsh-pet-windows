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

## 五、碎碎念 / 对话（模型通道）

上游把生成收口在 DSH 的 `ctx.llm`；独立模式与打包版原先没有模型后端，所以这两个功能不可用。
现在补上了**模型通道**：把 `ctx.llm` 接到一个 OpenAI 兼容的 chat completions 端点上，
上游的 `whisper.ts` / `chat.ts` 一行没改。

配置来源（优先级从高到低，第一个可用者胜出）：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `DSH_PET_LLM_CONFIG` 指向的 JSON | 排障 / 多份配置切换 |
| 2 | `%USERPROFILE%\.dsh\dsh-pet\standalone-llm.json` | 推荐：与宠物配置同处一地，字段 `{provider, baseUrl, apiKey, model, maxTokens?, reasoningEffort?}` |
| 3 | 环境变量 | `DSH_PET_LLM_BASE_URL` + `DSH_PET_LLM_API_KEY`（+ `DSH_PET_LLM_MODEL`） |
| 4 | **自动复用 WorkBuddy 已配置的模型** | 读 `~/.workbuddy-ai/models.json`（`CODEBUDDY_CONFIG_DIR` 优先），取第一条模型的 url/key |

也就是说：**只要 WorkBuddy 里配好了模型，桌宠开箱即用，不需要额外填 key。**

实测（GLM Coding Plan 端点）：

- `glm-5.3` 属"始终思考"的模型，**不接受关闭思考**（传 `thinking:{type:disabled}` 会被 400 拒，
  报文原话：「该模型始终思考，不支持关闭思考；请使用 low、high 或 max」）；
- 传 `reasoning_effort: 'low'` 时思考 token 归零、**1.1 秒出正文**；不传则先烧掉数百个
  reasoning token——`max_tokens` 给小了会拿到**空 content**（最容易踩的坑）；
- 因此通道**默认带 `reasoning_effort: 'low'`、`max_tokens: 512`**；
- 实测输出：「今天出门忘带伞了，偏偏下午就下雨，唉。」「主人辛苦啦，累的时候就歇歇嘛~」

## 六、系统通知（WorkBuddy hooks → Windows 原生通知）

独立模式与打包版没有 DSH 会话，通知改由 **WorkBuddy hooks** 驱动：

```
WorkBuddy 事件 → workbuddy-hook.mjs（投影）→ POST /dsh-pet-7340/notify
              → 宿主写 S.sections.notify → 桌面渲染端弹 Windows 通知
```

安装（脚本会把 hook 复制到稳定落点 `~/.dsh/dsh-pet/workbuddy-hook.mjs`，并**先备份**你的 settings.json）：

```bat
node runtime\win\install-workbuddy-hooks.mjs --dry-run   :: 先看变更
node runtime\win\install-workbuddy-hooks.mjs             :: 安装（Stop / PermissionRequest / Notification）
node runtime\win\install-workbuddy-hooks.mjs --uninstall :: 卸载
```

**⚠️ 装完必须完全退出 WorkBuddy 再打开**——它的 hooks 配置在启动时缓存，点关闭按钮只是关窗口。

弹什么：

| WorkBuddy 事件 | 通知 |
| --- | --- |
| `Stop`（回复以陈述结尾） | 「对话完成」 |
| `Stop`（回复以问句结尾） | 「模型在等你回答」 |
| `Notification` = `idle_prompt` | 「WorkBuddy 空闲中，等你交代下一步」 |
| `PermissionRequest` | 「正在申请权限：工具「Bash」」 |

其余高频事件（`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse`）**不弹**——
每个工具调用都弹会变成骚扰。

**隐私**：投影脚本只保留结构字段（事件名 / session_id / 工具名 / 权限模式 / "回复是否以问句结尾"这个布尔），
`prompt`、`tool_input`、`last_assistant_message`、`transcript_path` 等含内容的字段**一个都不读、不写盘、不发送**
（有单测守着这条契约）。另外这是 **fail-open**：桌宠没开、端口不对、超时——hook 静默退出，绝不卡住 WorkBuddy。

## 七、余额

**WorkBuddy 侧没有账户余额接口**（`usage-log.json` 只是功能使用统计，不是金额；Coding Plan 是订阅制），
所以默认的 WorkBuddy 通道下余额显示为不可用（结构化失败，不伪造数字）。

要显示余额，把 provider 换成有余额接口的服务商即可（上游已实现取数，只需给 key）：

```jsonc
// %USERPROFILE%\.dsh\dsh-pet\standalone-llm.json
{
  "provider": "deepseek-official",          // 同时决定模型通道与余额路由
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "sk-你的 DeepSeek key",
  "model": "deepseek-chat"
}
```

配好后 `/balance` 与右键「查看余额」会走 `GET https://api.deepseek.com/user/balance`，
余额、档位动画、峰谷档位全部与 DSH 内运行时一致。

## 八、本项目的修复记录（相对上游 PC2005-cloud/dsh-pet@6abec90）

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
4. **单测**：新增 4 个用例覆盖降级纯函数与重启注入，另同步两处防漂移守卫。
5. **启动器**：新增 `start-pet.bat` / `stop-pet.bat` / `stop-pet.mjs`（源码模式）与
   `stop-pet.cmd` / `stop-pet.ps1`（打包模式，不依赖 Node），均已实测闭环。
6. **模型通道（碎碎念 / 对话）**：新增 `src/standalone/llm-channel.ts`（OpenAI 兼容流式 +
   四级配置来源，含自动复用 WorkBuddy 的模型），并把 `ctx.llm` / `credentials` /
   `agentDefaultModel` 接上；`BlockAssembler` 补终止块支持（"思考吃光预算"能报准确原因）。
   期间修掉一个真 bug：**一个网络分片含多行 SSE 时，只交付第一块、丢掉同批其余行**——
   短碎碎念看不出，长对话回复被腰斩（已加"一分片多行"回归用例钉住）。
7. **系统通知**：新增入站端点 `POST /dsh-pet-7340/notify`、桌面端 toast 实现
   （复用 shared 的 `frameToToast` 映射 + `app.setAppUserModelId`）、WorkBuddy hook 投影脚本
   与安装器（`runtime/win/`）。实测链路：hook → 投影 → 投递 → 原生通知（日志可见
   `【弹窗】模型在等你回答：WorkBuddy 在等你回答`）。
8. **测试**：全套 **709 项**通过（新增模型通道 26 例、hook 链路 20 例，另同步 4 处旧契约断言）。

验证截图：`smoke-auto.png`（源码模式）、`pack-smoke.png`（打包 exe，透明背景 + 动画 +
自绘右键菜单均正常，零 GPU 崩溃）。

## 九、从源码重新构建 / 打包

```bat
cd /d %USERPROFILE%\path\to\dsh-pet\dsh-pet
corepack pnpm install --config.node-linker=hoisted
npm run build          :: lib/ + shared-core.js + 类型声明
npm run pack:win       :: dist\dsh-pet-win\dsh-pet.exe（约 400MB，自包含）
```

上游仓库 README 的「Windows 排障」一节已同步本修复说明。
