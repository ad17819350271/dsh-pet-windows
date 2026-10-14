#!/usr/bin/env node
/**
 * workbuddy-hook.mjs —— WorkBuddy hooks → dsh-pet 系统通知的**投影脚本**。
 *
 * 链路：WorkBuddy 事件 → 本脚本（stdin 收 payload）→ POST http://127.0.0.1:<port>/dsh-pet-7340/notify
 *       → 宿主写进 S 的 sections.notify → 桌面渲染端弹 Windows 原生通知。
 *
 * 【隐私第一原则】只投影响应"发生了什么"，绝不落地对话内容：
 *   - 白名单取字段：event / session_id / tool_name / permission_mode / notification_type，
 *     外加 Stop 事件里"回复是不是以问句结尾"这一个**布尔**；
 *   - prompt、tool_input、last_assistant_message、transcript_path 等含内容的字段一个都不读、
 *     不写盘、不发出去（有单测守着这条契约）。
 *
 * 【fail-open】桌宠没开、端口不对、请求超时——一律静默退出 0。状态指示器永远不该卡死正经工作流。
 *
 * 用法（由 WorkBuddy 的 hooks 配置调用，见 install-workbuddy-hooks.mjs）：
 *   node workbuddy-hook.mjs Stop            # 事件名作为第一个参数
 *   echo '<payload json>' | node workbuddy-hook.mjs PreToolUse
 *
 * 环境变量：
 *   DSH_PET_PORT        桌宠端口（缺省从 3080 起扫到 3104）
 *   DSH_PET_HOOK_DEBUG=1 打印投影结果与请求结果（排障用）
 */
import { request } from 'node:http';

/** 端口扫描范围：与桌宠独立模式/打包版的首选端口与顺延范围一致 */
const PORTS = Array.from({ length: 25 }, (_, i) => 3080 + i);
/** 单次请求超时（ms）：hook 是**阻塞** WorkBuddy 的，必须短 */
const REQUEST_TIMEOUT_MS = 1500;
/** 读 stdin 的超时（ms）：没有 payload 时不该挂着 */
const STDIN_TIMEOUT_MS = 500;

const debug = process.env.DSH_PET_HOOK_DEBUG === '1';
const log = (...args) => {
  if (debug) process.stderr.write('[dsh-pet-hook] ' + args.join(' ') + '\n');
};

/** 读全部 stdin（超时/出错都当空） */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (piece) => {
      data += piece;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** 回复是否以问句结尾（**只取布尔**，不保留正文） */
export function endsWithQuestion(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed === '') return false;
  return /[?？]$/.test(trimmed);
}

/**
 * 把 hook payload 投影成"只含结构字段"的事件（纯函数，单测直接调用）。
 * @param event hook 事件名（Stop / PermissionRequest / Notification / …）
 * @param payload WorkBuddy 传进来的 JSON
 */
export function project(event, payload) {
  const d = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const out = {
    event,
    ts: Date.now(),
    session_id: typeof d.session_id === 'string' ? d.session_id : undefined,
    tool_name: typeof d.tool_name === 'string' ? d.tool_name : undefined,
    permission_mode: typeof d.permission_mode === 'string' ? d.permission_mode : undefined,
    notification_type: typeof d.notification_type === 'string' ? d.notification_type : undefined,
    ends_with_question: event === 'Stop' ? endsWithQuestion(d.last_assistant_message) : undefined,
  };
  // 去掉 undefined 键：投影结果要么有值，要么没有——不留"看起来有字段其实为空"的中间态
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

/**
 * 投影事件 → 通知帧（与 shared/notify.ts 的帧契约完全一致）。
 * @returns undefined = 这个事件不产生通知（绝大多数工具事件属于此类：太吵）
 */
export function toNotifyFrame(projected) {
  const { event, tool_name: toolName, notification_type: notificationType } = projected;
  // 任务跑完：workbuddy 干完一轮会发 Stop；以问句结尾说明它在等你回话 → 换成"在等你"的语义
  if (event === 'Stop') {
    return projected.ends_with_question
      ? { type: 'question/requested', questions: [{ question: 'WorkBuddy 在等你回答' }] }
      : { type: 'session/event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } };
  }
  // 空闲提示：WorkBuddy 明确说"该你了"
  if (event === 'Notification' && notificationType === 'idle_prompt') {
    return { type: 'question/requested', questions: [{ question: 'WorkBuddy 空闲中，等你交代下一步' }] };
  }
  // 申请权限：弹"正在申请权限"
  if (event === 'PermissionRequest') {
    return {
      type: 'approval/requested',
      toolName: toolName ?? '',
      reason: 'WorkBuddy 需要你批准这次操作',
    };
  }
  // 其余（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Notification 其它类型）不弹
  return undefined;
}

/** POST 一帧到桌宠；成功返回 true。任何失败都返回 false（调用方一律静默退出） */
export function postFrame(frame, ports = PORTS, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let index = 0;
    const body = JSON.stringify(frame);
    const tryNext = () => {
      if (index >= ports.length) {
        resolve(false);
        return;
      }
      const port = ports[index++];
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/dsh-pet-7340/notify',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          // 2xx 即视为送达（{ok:false,reason:'disabled'} 也算送达：用户关了通知，不该再试下一个端口）
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
          else tryNext();
        },
      );
      req.on('timeout', () => {
        req.destroy();
        tryNext();
      });
      req.on('error', () => tryNext()); // 端口没人听：试下一个
      req.end(body);
    };
    tryNext();
  });
}

/** 入口：读 payload → 投影 → 映射 → 发送。**永远 exit 0**（fail-open） */
async function main() {
  const event = process.argv[2] ?? '';
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    log('payload 不是合法 JSON，按空处理');
  }
  const projected = project(event, payload);
  log('投影：' + JSON.stringify(projected));
  const frame = toNotifyFrame(projected);
  if (!frame) {
    log('该事件不产生通知，退出');
    return;
  }
  const explicitPort = Number(process.env.DSH_PET_PORT);
  const ports = Number.isFinite(explicitPort) && explicitPort > 0 ? [explicitPort] : PORTS;
  const ok = await postFrame(frame, ports);
  log(ok ? '已送达桌宠' : '桌宠未响应（未运行？端口不对？）');
}

// 仅在被直接执行时跑 main（被单测 import 时不跑）
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().finally(() => process.exit(0));
}
