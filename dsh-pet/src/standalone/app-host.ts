/**
 * 内嵌宿主入口 —— 给**打包成独立 Windows App**（`dsh-pet.exe`）用的一份宿主半边封装。
 *
 * 与 `./cli.ts`（独立模式 CLI）的区别只在"谁来拉起桌面窗口"：
 *   - CLI：宿主半边跑在 Node 进程里，经 `DSH_PET_BRIDGE=1` 管道把窗口交给**另一个** Electron 进程；
 *   - 打包 App：Electron 主进程自己就是窗口进程（`runtime/electron-helper/main.js`），
 *     于是把宿主半边**搬进同一个进程**跑（`DSH_PET_EMBED_HOST=1`，见该文件），
 *     窗口渲染端经 `http://127.0.0.1:<port>` 直接取数（无管道、无第二个进程、无外部 Node）。
 *
 * 三件事：
 *   1. `startPetHost()` —— 起伪 ctx + 真 `node:http` 服务 + `apply()`（路由表仍只有插件那一份）；
 *   2. 给每条路由**补 CORS 头** —— 打包 App 的渲染端页面是 `file://` 源（origin 为 `null`），
 *      跨源取数必须 ACAO；DSH 内走 bridge 管道、独立 CLI 走管道，都没有这一步；
 *   3. `readDesktopPets()` —— 让窗口进程自己算「该开几个窗口」（原来由宿主经 `DSH_PET_PETS` 透传）。
 *
 * 只在打包构建里生效：`tsdown.config.mjs` 的第四份配置把它编成 `lib/app-host.cjs`
 * （CJS —— Electron 主进程是 CJS，`require()` 最省事），并把三个 DSH 专有包换成
 * `src/standalone/shims/*`、把 `@electron/get` 桩掉（打包 App 自带 Electron，不会走下载路径，
 * 于是产物**不需要任何 node_modules**）。
 */
import { join } from 'node:path';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir, packageRoot } from '../host/helper-process';
import { apply } from '../host/index';
import { createStandaloneContext, createStandaloneLogger, type RegisteredRoute, type StandaloneLogger } from './context';
import { configPathsFor, isDesktopVisible } from './options';
import { listenStandaloneServer } from './server';

/** 插件路由前缀（与 `src/host/index.ts` 的 ROUTE_PREFIX 一致；那边是私有常量，这里导出给窗口进程拼 URL） */
export const ROUTE_PREFIX = '/dsh-pet-7340';

/** 独立 App 的默认端口（被占用时向后顺延，见 server.ts 的 PORT_SCAN_LIMIT） */
export const DEFAULT_APP_PORT = 3080;

/** 一只桌面可见宠物（窗口进程据此建窗，每只一个局部小窗口） */
export interface DesktopPet {
  id: string;
  size: number;
}

export interface PetHost {
  /** 实际监听端口（首选端口被占用时大于请求值） */
  port: number;
  /** 渲染端取成品配置的地址（窗口进程把它写进 DSH_PET_CONFIG_URL） */
  configUrl: string;
  /** 收尾：先释放插件 effect（停周期定时器），再关 HTTP 服务 */
  dispose(): Promise<void>;
}

/**
 * 起内嵌宿主：伪 ctx → 真 HTTP 服务 → `apply()`。
 * @param options 首选端口、日志器与停机回调（缺省：3080 / 控制台 / 不停机）
 * @returns 端口、configUrl 与释放函数
 */
export async function startPetHost(
  options: { port?: number; logger?: StandaloneLogger; onShutdown?: () => void } = {},
): Promise<PetHost> {
  const logger = options.logger ?? createStandaloneLogger();
  const routes: RegisteredRoute[] = [];
  const portRef = { value: options.port ?? DEFAULT_APP_PORT };
  const context = createStandaloneContext({
    port: () => portRef.value,
    logger,
    routes,
    // 让 <DSH_HOME>/dsh-pet/standalone-llm.json 被发现（模型通道的用户配置层）
    userConfigDir: join(dshHomeDir(), 'dsh-pet'),
  });

  let disposed = false;
  const server = await listenStandaloneServer({
    routes,
    logger,
    port: portRef.value,
    // POST /shutdown：打包 App 里这是**唯一的脚本化退出入口**（窗口没有关闭按钮，
    // 右键菜单也没有「退出」项）——调用方（App 主进程）通常接成 app.quit()。
    // 没有接回调时保持"只应答不动手"，绝不假装退出了。
    onShutdown: options.onShutdown,
  });
  portRef.value = server.port;

  // 路由注册（apply 内部经 ctx.webServer.register 落到上面的 routes 数组）
  apply(context.ctx);

  // 补 CORS：渲染端页面是 file:// 源（origin = null），跨源取数必须有 ACAO。
  // 用 setHeader 而不是改 handler 的响应头：Node 的 writeHead 会**合并**已 setHeader 的值
  // （同名时以 writeHead 传入的为准），所以插件自己写的头不会被我们覆盖掉。
  for (const route of routes) {
    const inner = route.handler;
    route.handler = (req, res) => {
      try {
        res.setHeader('access-control-allow-origin', '*');
      } catch {
        /* 头已发出：交给 inner 处理（与 server.ts 的 fail 口径一致） */
      }
      return inner(req, res);
    };
  }

  logger.info(`内嵌宿主已就绪：http://127.0.0.1:${server.port}${ROUTE_PREFIX}/（${routes.length} 条路由）`);
  if (context.failures.length > 0) {
    logger.warn(`初始化期间有 ${context.failures.length} 项失败（路由仍可用，相关端点会显式报错）`);
  }

  return {
    port: server.port,
    configUrl: `http://127.0.0.1:${server.port}${ROUTE_PREFIX}/config`,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await context.dispose();
      await server.close();
    },
  };
}

/**
 * 该开几个桌面窗口（`display` 含 `desktop`/`both` 的实例）。
 * 读不到配置 / 配置非法时返回空数组：窗口进程据此不建窗（而不是建一个不知道尺寸的窗口）。
 */
export function readDesktopPets(): DesktopPet[] {
  const paths = configPathsFor(packageRoot, dshHomeDir());
  return (
    flattenPetList(readAllConfig(paths))
      // 注意 isDesktopVisible 收的是**宠物对象**（与 host/index.ts 里同名但收 display 字符串的私有函数不同）
      .filter((pet) => isDesktopVisible(pet))
      .map((pet, index) => ({
        id: String(pet?.id ?? `pet-${index}`),
        size: Number(pet?.size) > 0 ? Number(pet.size) : 462,
      }))
  );
}
