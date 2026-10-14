/**
 * WorkBuddy hook 链路单元测试 —— 投影（隐私）/ 帧映射 / 投递 / 安装器合并。
 *
 * 三条不变式在这里钉死：
 *   1. **隐私**：投影结果里不许出现任何含内容的字段（prompt / tool_input / last_assistant_message /
 *      transcript_path）。塞 SECRET 进去，断言输出里一个字都搜不到。
 *   2. **fail-open**：桌宠没开时投递必须安静失败（返回 false），绝不抛、绝不卡住 WorkBuddy。
 *   3. **幂等可逆**：安装器重复装只有一条、卸载能精确还原用户原有配置。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { endsWithQuestion, postFrame, project, toNotifyFrame } from '../../runtime/win/workbuddy-hook.mjs';
import { applyHooks } from '../../runtime/win/install-workbuddy-hooks.mjs';

describe('endsWithQuestion —— 只产出一个布尔', () => {
  test('问句（中英文标点）→ true；陈述/空/非字符串 → false', () => {
    assert.equal(endsWithQuestion('要我继续吗？'), true);
    assert.equal(endsWithQuestion('Continue?'), true);
    assert.equal(endsWithQuestion('已经做完了。'), false);
    assert.equal(endsWithQuestion('   '), false);
    assert.equal(endsWithQuestion(undefined), false);
    assert.equal(endsWithQuestion(123), false);
  });
});

describe('project —— 隐私投影：只留结构字段', () => {
  test('含内容的字段一个都不进结果', () => {
    const projected = project('PreToolUse', {
      session_id: 's-1',
      tool_name: 'Bash',
      permission_mode: 'default',
      prompt: 'SECRET-PROMPT',
      tool_input: { command: 'SECRET-COMMAND' },
      last_assistant_message: 'SECRET-REPLY',
      transcript_path: 'C:/SECRET-PATH/session.jsonl',
      cwd: 'C:/SECRET-CWD',
    });
    const text = JSON.stringify(projected);
    for (const secret of ['SECRET-PROMPT', 'SECRET-COMMAND', 'SECRET-REPLY', 'SECRET-PATH', 'SECRET-CWD']) {
      assert.equal(text.includes(secret), false, `投影结果泄漏了 ${secret}`);
    }
    // 结构字段该留的都留着
    assert.equal(projected.event, 'PreToolUse');
    assert.equal(projected.session_id, 's-1');
    assert.equal(projected.tool_name, 'Bash');
    assert.equal(projected.permission_mode, 'default');
    assert.equal(typeof projected.ts, 'number');
  });

  test('ends_with_question 只在 Stop 事件里出现，且只是布尔', () => {
    const stop = project('Stop', { last_assistant_message: '要我继续吗？' });
    assert.equal(stop.ends_with_question, true);
    const tool = project('PreToolUse', { last_assistant_message: '要我继续吗？' });
    assert.equal('ends_with_question' in tool, false);
  });

  test('payload 不是对象（null / 字符串 / 数组）也不炸', () => {
    assert.equal(project('Stop', null).event, 'Stop');
    assert.equal(project('Stop', 'oops').event, 'Stop');
    assert.equal(project('Stop', []).event, 'Stop');
  });

  test('undefined 键被清掉（不留"看起来有字段其实为空"的中间态）', () => {
    // 用非 Stop 事件：Stop 一定会带 ends_with_question（哪怕是 false）
    const projected = project('PreToolUse', {});
    assert.deepEqual(Object.keys(projected).sort(), ['event', 'ts']);
    // Stop 事件则一定带那个布尔（false 也是有效信息：陈述结尾）
    assert.deepEqual(Object.keys(project('Stop', {})).sort(), ['ends_with_question', 'event', 'ts']);
  });
});

describe('toNotifyFrame —— 投影事件 → 通知帧（与 shared/notify.ts 同契约）', () => {
  test('Stop（陈述结尾）→ 对话完成帧', () => {
    const frame = toNotifyFrame(project('Stop', { last_assistant_message: '搞定了。' }));
    assert.deepEqual(frame, { type: 'session/event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } });
  });

  test('Stop（问句结尾）→ "在等你回答"帧（同一个事件，语义不同）', () => {
    const frame = toNotifyFrame(project('Stop', { last_assistant_message: '要我继续吗？' }));
    assert.ok(frame, '问句结尾必须产生帧');
    assert.equal(frame.type, 'question/requested');
    assert.match(String((frame.questions as Array<{ question: string }>)[0].question), /等你回答/);
  });

  test('Notification(idle_prompt) → "等你交代下一步"帧', () => {
    const frame = toNotifyFrame(project('Notification', { notification_type: 'idle_prompt' }));
    assert.ok(frame, 'idle_prompt 必须产生帧');
    assert.equal(frame.type, 'question/requested');
    // 其它 notification_type 不弹
    assert.equal(toNotifyFrame(project('Notification', { notification_type: 'auth_success' })), undefined);
  });

  test('PermissionRequest → 申请权限帧（带工具名）', () => {
    const frame = toNotifyFrame(project('PermissionRequest', { tool_name: 'Bash', permission_mode: 'default' }));
    assert.ok(frame, 'PermissionRequest 必须产生帧');
    assert.equal(frame.type, 'approval/requested');
    assert.equal(frame.toolName, 'Bash');
  });

  test('高频事件（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse）不产生通知', () => {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
      assert.equal(toNotifyFrame(project(event, { tool_name: 'Bash' })), undefined, `${event} 不该弹通知`);
    }
  });
});

describe('postFrame —— 投递（fail-open）', () => {
  test('端口有人听 → 收到帧并返回 true', async () => {
    const received: Array<{ url?: string; frame: unknown }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (piece) => (body += piece));
      req.on('end', () => {
        received.push({ url: req.url, frame: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const frame = { type: 'session/event', event: { type: 'turn/end' } };
      assert.equal(await postFrame(frame, [port]), true);
      assert.equal(received.length, 1);
      assert.equal(received[0].url, '/dsh-pet-7340/notify');
      assert.deepEqual(received[0].frame, frame);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('没有端口在听 → 安静返回 false（不抛、不卡住 WorkBuddy）', async () => {
    // 选一段几乎不可能被占用的高端口，且只试两个
    assert.equal(await postFrame({ type: 'x' }, [59981, 59982], 300), false);
  });

  test('非 2xx → 视为未送达（继续试下一个端口）', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      assert.equal(await postFrame({ type: 'x' }, [port], 500), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('applyHooks —— 安装器合并（幂等 / 可逆 / 不碰用户配置）', () => {
  /** hook 条目的最小形状（构造"用户自己配的"与"我们装的"两种都要它） */
  type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string }> };
  const userEntry: HookEntry = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] };
  /** 模拟我们装过的那条 */
  const ours = (event: string): HookEntry => ({
    hooks: [{ type: 'command', command: `"node" "C:/x/workbuddy-hook.mjs" ${event}` }],
  });

  /** 我们装的那条命令长什么样（路径分隔符平台相关，断言只看关键片段） */
  const isOurCommand = (command: string): boolean =>
    command.includes('workbuddy-hook.mjs') && /\bStop\b/.test(command);

  test('全新安装：每个事件一条我们的 hook', () => {
    const next = applyHooks(undefined, ['Stop'], false) as Record<string, HookEntry[]>;
    assert.ok(next);
    assert.equal(next.Stop.length, 1);
    assert.ok(isOurCommand(next.Stop[0].hooks[0].command));
    // 事件名作为**最后一个参数**传给投影脚本（它靠 argv[2] 区分事件）
    assert.match(next.Stop[0].hooks[0].command, /Stop"?$|\sStop$/);
  });

  test('重复安装不堆叠（幂等）', () => {
    const first = applyHooks(undefined, ['Stop'], false) as Record<string, HookEntry[]>;
    const second = applyHooks({ ...first, Stop: [ours('Stop'), ...first.Stop] }, ['Stop'], false) as Record<
      string,
      HookEntry[]
    >;
    // 无论之前堆了几条，装完只剩一条我们的
    assert.equal(
      second.Stop.filter((entry) => entry.hooks.some((hook) => hook.command.includes('workbuddy-hook.mjs'))).length,
      1,
    );
  });

  test('用户自己配的 hook 一字不动，我们的插在最前', () => {
    const next = applyHooks({ Stop: [userEntry] }, ['Stop'], false) as Record<string, HookEntry[]>;
    assert.equal(next.Stop.length, 2);
    assert.ok(isOurCommand(next.Stop[0].hooks[0].command));
    assert.deepEqual(next.Stop[1], userEntry);
  });

  test('卸载：精确移除我们的条目并保留用户的；只剩用户条目时不删事件键', () => {
    const next = applyHooks({ Stop: [ours('Stop'), userEntry] }, ['Stop'], true) as Record<string, HookEntry[]>;
    assert.deepEqual(next.Stop, [userEntry]);
  });

  test('卸载：该事件下只有我们的条目 → 连事件键一起清掉', () => {
    const next = applyHooks({ Stop: [ours('Stop')] }, ['Stop'], true) as Record<string, unknown>;
    assert.equal('Stop' in next, false);
  });

  test('脏数据（hooks 非对象 / 事件值非数组）不炸', () => {
    assert.ok(applyHooks('oops', ['Stop'], false));
    assert.ok(applyHooks({ Stop: 'not-an-array' }, ['Stop'], false));
    assert.ok(applyHooks([], ['Stop'], false));
  });

  test('已是目标状态 → 返回 null（调用方据此跳过写盘/备份）', () => {
    assert.equal(applyHooks({}, ['Stop'], true), null);
  });
});
