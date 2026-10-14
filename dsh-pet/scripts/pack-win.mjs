#!/usr/bin/env node
/**
 * pack-win.mjs —— 把 dsh-pet 打成一个**自包含的 Windows 便携 App**（dist/dsh-pet-win/dsh-pet.exe）。
 *
 * 为什么要自建打包脚本而不是 electron-builder：
 *   本插件的桌面形态是"宿主半边 + Electron 窗口进程"两段式，标准打包器默认只认后者。
 *   我们已经在 `runtime/electron-helper/main.js` 里加了内嵌宿主模式（DSH_PET_EMBED_HOST=1）——
 *   宿主半边（路由/配置/状态/定时器）直接跑在 Electron 主进程内，于是**一个进程就是全部**，
 *   不需要外部 Node、不需要下载 Electron、不需要 node_modules（见 tsdown 的第四份配置）。
 *   剩下的只是"把 Electron 发行版和我们的 app 目录摆到一起"——就是本脚本。
 *
 * 产物布局（Electron 的默认应用查找顺序：resources/app.asar → resources/app）：
 *   dist/dsh-pet-win/
 *     dsh-pet.exe            ← electron.exe 改名（用户双击的就是它）
 *     *.dll / *.pak / locales/ ...   ← Electron 运行时原样搬过来
 *     resources/app/
 *       package.json         ← main = runtime/electron-helper/main.js
 *       lib/app-host.cjs     ← 内嵌宿主（零外部依赖）
 *       runtime/electron-helper/*  ← 窗口进程（main.js / renderer.js / shared-core.js / index.html ...）
 *       assets/{webm,fonts,pic,memes,config.jsonc,logo.png}
 *
 * 用法：
 *   node scripts/pack-win.mjs                 # 默认输出 dist/dsh-pet-win
 *   node scripts/pack-win.mjs --out <目录>
 *   node scripts/pack-win.mjs --electron <已解压的 electron 目录>   # 跳过自动定位
 *
 * 环境变量：
 *   DSH_HOME                   Electron 落地根（默认 ~/.dsh → 用其中的 electron/）
 *   DSH_PET_ELECTRON_SRC       同上，直接指定已解压的 Electron 目录
 *   DSH_PET_RCEDIT             指定 rcedit.exe（换 exe 图标/版本信息；缺省自动尝试下载）
 *   DSH_PET_SKIP_ICON=1        跳过图标与版本信息改写
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(argValue('--out') ?? join(ROOT, 'dist', 'dsh-pet-win'));
const EXE_NAME = 'dsh-pet.exe';

/** 取 `--key value` 形式的参数 */
function argValue(key) {
  const i = process.argv.indexOf(key);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

/** 人类可读体积 */
function human(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

/** 递归求目录体积 */
function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

/** Electron 发行版目录：命令行 > 环境变量 > $DSH_HOME/electron（ensure-electron.mjs 的落地路径） */
function resolveElectronDir() {
  const explicit = argValue('--electron') ?? process.env.DSH_PET_ELECTRON_SRC;
  if (explicit) return resolve(explicit);
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  return resolve(home, 'electron');
}

/** 构建产物必须齐全：缺一件就别打包（否则产出一个跑不起来的 exe，用户只会看到黑窗一闪） */
function assertBuildInputs(electronDir) {
  const required = [
    join(electronDir, 'electron.exe'),
    join(ROOT, 'lib', 'app-host.cjs'),
    join(ROOT, 'runtime', 'electron-helper', 'main.js'),
    join(ROOT, 'runtime', 'electron-helper', 'shared-core.js'),
    join(ROOT, 'assets', 'config.jsonc'),
    join(ROOT, 'assets', 'webm'),
  ];
  const missing = required.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(
      '打包输入缺失：\n  ' +
        missing.join('\n  ') +
        '\n先跑 `npm run build`（生成 lib/ 与 shared-core.js）；Electron 缺失时先 `npm run ensure:electron`。',
    );
  }
}

/** 写 app 的 package.json（Electron 据 main 找入口；不带 type 字段 = CJS，与 main.js 一致） */
function writeAppPackageJson(appDir) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const out = {
    name: 'dsh-pet',
    productName: 'dsh-pet 桌宠',
    version: pkg.version,
    description: pkg.description,
    main: 'runtime/electron-helper/main.js',
    private: true,
  };
  writeFileSync(join(appDir, 'package.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
}

/** 组装 resources/app（只带运行时真正要读的东西；assets/preview 是 README 用的 GIF，65MB，不进包） */
function buildAppDir(appDir) {
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });

  writeAppPackageJson(appDir);

  // lib/：只要 app-host.cjs 及其分块（client.js/index.js/standalone.js 是 DSH 侧产物，App 用不到）
  const libDir = join(appDir, 'lib');
  mkdirSync(libDir, { recursive: true });
  for (const entry of readdirSync(join(ROOT, 'lib'))) {
    if (entry === 'app-host.cjs' || entry.startsWith('extract-zip-')) {
      cpSync(join(ROOT, 'lib', entry), join(libDir, entry));
    }
  }

  cpSync(join(ROOT, 'runtime'), join(appDir, 'runtime'), { recursive: true });
  cpSync(join(ROOT, 'assets', 'webm'), join(appDir, 'assets', 'webm'), { recursive: true });
  for (const item of ['config.jsonc', 'logo.png']) {
    cpSync(join(ROOT, 'assets', item), join(appDir, 'assets', item));
  }
  for (const dir of ['fonts', 'pic', 'memes']) {
    cpSync(join(ROOT, 'assets', dir), join(appDir, 'assets', dir), { recursive: true });
  }
  for (const doc of ['Windows使用说明.md', 'README.md']) {
    if (existsSync(join(ROOT, doc))) cpSync(join(ROOT, doc), join(appDir, doc));
  }

  // 退出入口 + WorkBuddy 通知安装器（放到 exe 同级目录，用户直接看得到；都不依赖本机 Node 之外的依赖）
  for (const item of [
    'stop-pet.cmd',
    'stop-pet.ps1',
    'workbuddy-hook.mjs',
    'install-workbuddy-hooks.mjs',
  ]) {
    cpSync(join(ROOT, 'runtime', 'win', item), join(OUT, item));
  }
}

/** 把 PNG 包成单条目 ICO（Vista+ 支持 ICO 内嵌 PNG；避免引入图像库） */
function pngToIco(pngPath, icoPath) {
  const png = readFileSync(pngPath);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // width 0 = 256+
  entry.writeUInt8(0, 1); // height 0 = 256+
  entry.writeUInt8(0, 2); // 调色板
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // 数据偏移
  writeFileSync(icoPath, Buffer.concat([header, entry, png]));
}

/** 尽力而为的图标/版本信息改写：拿不到 rcedit 就跳过（不影响可用性，只是 exe 图标是 Electron 默认） */
function applyIconAndVersion(exePath) {
  if (process.env.DSH_PET_SKIP_ICON === '1') return '跳过（DSH_PET_SKIP_ICON=1）';
  const ico = join(OUT, 'dsh-pet.ico');
  try {
    pngToIco(join(ROOT, 'assets', 'logo.png'), ico);
  } catch (error) {
    return `跳过（生成 .ico 失败：${error instanceof Error ? error.message : String(error)}）`;
  }
  const rcedit = process.env.DSH_PET_RCEDIT;
  if (!rcedit || !existsSync(rcedit)) {
    return `已生成 ${ico}，但未找到 rcedit.exe（可用 DSH_PET_RCEDIT 指定；或手动应用该图标）`;
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const run = spawnSync(
    rcedit,
    [
      exePath,
      '--set-icon',
      ico,
      '--set-file-version',
      pkg.version,
      '--set-product-version',
      pkg.version,
      '--set-version-string',
      'ProductName',
      'dsh-pet',
      '--set-version-string',
      'FileDescription',
      'dsh-pet 桌面宠物',
      '--set-version-string',
      'LegalCopyright',
      'MIT',
    ],
    { stdio: 'inherit' },
  );
  return run.status === 0 ? `已应用图标与版本信息（${ico}）` : `rcedit 失败（exit ${run.status}）`;
}

function main() {
  const electronDir = resolveElectronDir();
  console.log(`[pack-win] electron : ${electronDir}`);
  console.log(`[pack-win] output   : ${OUT}`);
  assertBuildInputs(electronDir);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 1. Electron 运行时原样搬过来（exe 改名；其余 dll/pak/locales 一个不能少）
  cpSync(electronDir, OUT, { recursive: true });
  const srcExe = join(OUT, 'electron.exe');
  const dstExe = join(OUT, EXE_NAME);
  rmSync(dstExe, { force: true });
  renameSync(srcExe, dstExe);

  // 2. 我们的 app 目录
  buildAppDir(join(OUT, 'resources', 'app'));

  // 3. 图标/版本信息（尽力而为）
  const iconNote = applyIconAndVersion(dstExe);

  const appSize = dirSize(join(OUT, 'resources', 'app'));
  console.log(`[pack-win] ✓ ${dstExe}`);
  console.log(`[pack-win] app 目录 ${human(appSize)}，整体 ${human(dirSize(OUT))}`);
  console.log(`[pack-win] 图标：${iconNote}`);
  console.log('[pack-win] 双击 dsh-pet.exe 即可运行（无需 Node、无需联网下载）。');
}

try {
  main();
} catch (error) {
  console.error(`[pack-win] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
