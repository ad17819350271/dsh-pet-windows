/**
 * `@electron-internal/extract-zip` 的打包 App 替身（与 ./electron-get.ts 同因）。
 *
 * 原模块是 N-API 原生模块，只在"下载完 Electron 后解压"这一条路径上被**动态** import；
 * 打包 App 不会走那条路径。替身保证该动态 import 在产物里也能解析到东西（不抛 MODULE_NOT_FOUND），
 * 真被调到则给出可定位的错误。
 */
export default async function extract(): Promise<never> {
  throw new Error(
    'dsh-pet: 打包 App 内不解压 Electron（App 自带 Electron）。' +
      '若你在源码形态下跑宿主半边，请改用 node lib/standalone.js。',
  );
}
