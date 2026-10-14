#!/usr/bin/env node
/**
 * install-workbuddy-hooks.mjs —— 把 dsh-pet 的通知 hook 装进 WorkBuddy 的配置。
 *
 * 写什么：`<配置根>/settings.json` 的 `hooks` 字段（WorkBuddy 与 Claude Code 同构）：
 *   { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "\"<node>\" \"<hook.mjs>\" Stop" } ] } ], ... } }
 * 配置根取 `CODEBUDDY_CONFIG_DIR`（WorkBuddy 自己就这么注入），否则 `~/.workbuddy-ai`。
 *
 * 安全与可逆：
 *   - **改前先备份**（settings.json.bak-<时间戳>），失败不动原文件；
 *   - 只增删"我们自己那条"（按 hook 命令里是否含 workbuddy-hook.mjs 识别），
 *     用户在 hooks 里配的其它内容一字不动；
 *   - `--uninstall` 精确移除我们加过的条目，空数组也一并清掉，恢复原样；
 *   - `--dry-run` 只打印将发生的变更。
 *
 * ⚠️ WorkBuddy 的 hooks 配置**在启动时缓存**：装完必须**完全退出**（关窗不算退出）再启动才生效。
 *
 * 用法：
 *   node install-workbuddy-hooks.mjs                 # 安装（默认装 Stop / PermissionRequest / Notification）
 *   node install-workbuddy-hooks.mjs --dry-run       # 只看变更
 *   node install-workbuddy-hooks.mjs --uninstall     # 卸载
 *   node install-workbuddy-hooks.mjs --node "C:\\path\\to\\node.exe"   # 指定跑 hook 的 node
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本脚本所在目录（hook 脚本与它同目录） */
const HERE = dirname(fileURLToPath(import.meta.url));
/** 投影脚本源路径（会被复制到稳定位置，见 installedHookPath） */
const HOOK_SOURCE = join(HERE, 'workbuddy-hook.mjs');
/** 默认装哪些事件：只装有意义的三个，其余事件太吵（每个工具调用都弹会变成骚扰） */
const DEFAULT_EVENTS = ['Stop', 'PermissionRequest', 'Notification'];
/** 识别"我们那条"的标记 */
const MARKER = 'workbuddy-hook.mjs';

function argValue(key) {
  const i = process.argv.indexOf(key);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const DRY_RUN = process.argv.includes('--dry-run');
const UNINSTALL = process.argv.includes('--uninstall');
/** 就地引用（开发用）：不复制，直接指向仓库里的脚本 */
const IN_PLACE = process.argv.includes('--in-place');
const EVENTS = (argValue('--events') ?? DEFAULT_EVENTS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 配置根：CODEBUDDY_CONFIG_DIR 优先（WorkBuddy 自己就这么注入），否则 ~/.workbuddy-ai */
function configDir() {
  const dir = process.env.CODEBUDDY_CONFIG_DIR;
  return typeof dir === 'string' && dir.trim() !== '' ? dir : join(homedir(), '.workbuddy-ai');
}

/**
 * hook 脚本的**稳定落点**：`<DSH_HOME>/dsh-pet/workbuddy-hook.mjs`（与宠物配置同处一地）。
 *
 * 为什么不直接引用脚本原路径：原路径可能是
 *   - 打包 App 的 `resources/app/runtime/win/`（用户移动/重装 App 目录就断）；
 *   - 某次构建的工作区（临时目录会被清理）。
 * WorkBuddy 的 hooks 配置是长期存在的，指向一个会被搬走的路径等于装了个定时炸弹。
 * `--in-place` 可退回引用原路径（开发调试用）。
 */
function installedHookPath() {
  const explicit = argValue('--hook-path');
  if (explicit) return resolve(explicit);
  if (IN_PLACE) return HOOK_SOURCE;
  const dshHome = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh');
  return join(dshHome, 'dsh-pet', MARKER);
}

/** 跑 hook 用的 node：显式指定 > 当前解释器（最可靠：装的时候能用，跑的时候也能用） */
function nodePath() {
  return argValue('--node') ?? process.execPath;
}

/** 我们的 hook 命令（路径带空格时用引号包住，Windows/Unix 都能解析） */
function hookCommand(event, hookPath) {
  return `"${nodePath()}" "${hookPath}" ${event}`;
}

/** 这条 hook 条目是不是我们装的 */
function isOurs(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (hook) => hook && typeof hook === 'object' && typeof hook.command === 'string' && hook.command.includes(MARKER),
  );
}

/**
 * 计算新的 hooks 配置（纯函数，便于测试与 dry-run 复用）。
 * @param hooks 现有 hooks 对象（可能是 undefined / 脏数据）
 * @param events 要装的事件名
 * @param uninstall true = 移除我们装的条目
 * @param hookPath 投影脚本落点（写进命令里）
 * @returns 新的 hooks 对象；null = 无需改动
 */
export function applyHooks(hooks, events, uninstall, hookPath = join(homedir(), '.dsh', 'dsh-pet', MARKER)) {
  const base = hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks) ? { ...hooks } : {};
  let changed = false;
  for (const event of events) {
    const list = Array.isArray(base[event]) ? base[event].slice() : [];
    const without = list.filter((entry) => !isOurs(entry));
    if (without.length !== list.length) changed = true;
    if (uninstall) {
      if (without.length > 0) base[event] = without;
      else if (event in base) {
        delete base[event];
        changed = true;
      }
      continue;
    }
    // 装：先摘掉旧的那条（幂等：重复安装不会堆叠），再插到最前
    base[event] = [{ hooks: [{ type: 'command', command: hookCommand(event, hookPath) }] }, ...without];
    changed = true;
  }
  return changed ? base : null;
}

function main() {
  const dir = configDir();
  const settingsPath = join(dir, 'settings.json');
  const hookPath = installedHookPath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (error) {
      console.error(
        `[install-hooks] ${settingsPath} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）；` +
          '为免破坏你的配置，本次不做任何改动。请先手工修好它。',
      );
      process.exit(1);
    }
  }

  const next = applyHooks(settings.hooks, EVENTS, UNINSTALL, hookPath);
  if (!next) {
    console.log('[install-hooks] 无需改动（配置已是目标状态）');
    return;
  }

  if (DRY_RUN) {
    console.log(`[install-hooks] --dry-run；投影脚本落点：${hookPath}`);
    console.log('[install-hooks] 将把 hooks 改成：');
    console.log(JSON.stringify(next, null, 2));
    return;
  }

  // 复制投影脚本到稳定落点（安装/卸载都做：卸载后留着也无害，用户想重装即用）
  if (!IN_PLACE && hookPath !== HOOK_SOURCE) {
    mkdirSync(dirname(hookPath), { recursive: true });
    copyFileSync(HOOK_SOURCE, hookPath);
    console.log(`[install-hooks] 投影脚本已复制 → ${hookPath}`);
  }

  // 备份：只备份"已有的"文件；时间戳后缀，绝不覆盖历史备份
  if (existsSync(settingsPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${settingsPath}.bak-${stamp}`;
    copyFileSync(settingsPath, backup);
    console.log(`[install-hooks] 已备份 → ${backup}`);
  }

  writeFileSync(settingsPath, JSON.stringify({ ...settings, hooks: next }, null, 2) + '\n', 'utf8');
  console.log(`[install-hooks] ✓ 已${UNINSTALL ? '移除' : '写入'} hooks（${EVENTS.join(' / ')}）→ ${settingsPath}`);
  console.log(`[install-hooks]   hook 命令：${hookCommand(EVENTS[0], hookPath)}`);
  if (!UNINSTALL) {
    console.log('');
    console.log('⚠️  必须**完全退出 WorkBuddy 再重新打开**（点关闭按钮只是关窗口，配置在启动时缓存）。');
    console.log('   重启后跑一个任务：任务完成 / 等你确认 / 申请权限时会弹 Windows 通知。');
    console.log('   排障：设 DSH_PET_HOOK_DEBUG=1 可看到投影结果与投递结果。');
  }
}

// 仅在被直接执行时跑 main（被单测 import 时不跑）
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main();
}
