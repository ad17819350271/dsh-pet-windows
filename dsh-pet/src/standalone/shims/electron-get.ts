/**
 * `@electron/get` 的打包 App 替身。
 *
 * 打包 App 自带 Electron（`dsh-pet.exe` 自己就是 Electron），永远不会走"下载 Electron"这条路；
 * 但 `src/host/helper-process.ts` 顶部是**静态 import** 它的，打包产物因此会把整棵依赖树
 * （got / decompress-response / …）拖进来，逼着 App 额外带一份 node_modules。
 *
 * 替身让这条边在构建期就断掉：真被调用（= 有人绕过了打包 App 的窗口进程、去跑纯宿主路径）
 * 就抛一句能定位原因的话，而不是静默失败。
 */
export function downloadArtifact(): never {
  throw new Error(
    'dsh-pet: 打包 App 内不提供 Electron 下载（App 自带 Electron）。' +
      '若你在源码形态下跑宿主半边，请改用 node lib/standalone.js，或设置 DSH_PET_ELECTRON_PATH。',
  );
}
