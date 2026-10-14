/**
 * install-workbuddy-hooks.mjs 的类型声明（脚本本身是运行时产物，不参与 TS 编译）。
 */

/** hooks 配置里的一条（Claude Code 同构） */
export interface HookEntryLike {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

/**
 * 计算新的 hooks 配置（纯函数）。
 * @param hooks 现有 hooks（可能是 undefined / 脏数据）
 * @param events 要装/要卸的事件名
 * @param uninstall true = 移除我们装的条目
 * @param hookPath 投影脚本落点（写进命令里）
 * @returns 新的 hooks 对象；null = 无需改动
 */
export declare function applyHooks(
  hooks: unknown,
  events: string[],
  uninstall: boolean,
  hookPath?: string,
): Record<string, HookEntryLike[]> | null;
