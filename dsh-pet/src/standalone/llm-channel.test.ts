/**
 * llm-channel 单元测试 —— 覆盖"配置解析 / 消息折平 / SSE 解析 / 流式消费"四块纯逻辑。
 *
 * 为什么必须测流式消费：SSE 的一个网络分片里通常含**多行** `data:`，而 `next()` 一次只交一个块。
 * 早期实现直接 `return` 第一个文本块、丢掉同批其余行——短碎碎念看不出来，长回复会被腰斩
 * （实测：对话回复只出半句）。这个 bug 只有"一次喂多行"的测试能钉住。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖：
 *   node --experimental-strip-types --test src/standalone/llm-channel.test.ts
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  contentToText,
  createStandaloneLlm,
  describeStandaloneLlm,
  flattenMessages,
  loadStandaloneLlmConfig,
  parseSseLine,
  pickWorkbuddyModel,
  workbuddyConfigDir,
  type StandaloneLlmConfig,
} from './llm-channel.ts';

describe('contentToText —— dsh-llm 的 content 折成纯文本', () => {
  test('字符串原样返回', () => {
    assert.equal(contentToText('你好'), '你好');
  });

  test('文本块数组拼接；非文本块忽略', () => {
    assert.equal(
      contentToText([
        { type: 'text', text: '你' },
        { type: 'tool-call', name: 'Bash' },
        { type: 'text', text: '好' },
      ]),
      '你好',
    );
  });

  test('形状不认识 → 空串（不抛）', () => {
    assert.equal(contentToText(undefined), '');
    assert.equal(contentToText(42), '');
    assert.equal(contentToText([{ type: 'text' }]), '');
  });
});

describe('flattenMessages —— system + 历史 → OpenAI messages', () => {
  test('system 非空时排在最前，空/缺省不占位', () => {
    const withSystem = flattenMessages([{ role: 'user', content: [{ type: 'text', text: '嗨' }] }], '人设');
    assert.deepEqual(withSystem, [
      { role: 'system', content: '人设' },
      { role: 'user', content: '嗨' },
    ]);
    const noSystem = flattenMessages([{ role: 'user', content: '嗨' }], '   ');
    assert.deepEqual(noSystem, [{ role: 'user', content: '嗨' }]);
  });

  test('user/assistant 交替保留；空正文与非法角色跳过', () => {
    const out = flattenMessages(
      [
        { role: 'user', content: '问' },
        { role: 'assistant', content: [{ type: 'text', text: '答' }] },
        { role: 'tool', content: '工具消息' },
        { role: 'assistant', content: [] },
      ],
      undefined,
    );
    assert.deepEqual(out, [
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答' },
    ]);
  });
});

describe('parseSseLine —— SSE 行解析', () => {
  test('data: {...} 取出增量文本', () => {
    const parsed = parseSseLine('data: {"choices":[{"delta":{"content":"喵"}}]}');
    assert.deepEqual(parsed, { text: '喵', finishReason: undefined });
  });

  test('finish_reason 单独成块时也要取到（GLM 的终止块没有 delta 正文）', () => {
    const parsed = parseSseLine('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}');
    assert.equal(parsed?.finishReason, 'stop');
    assert.equal(parsed?.text, undefined);
  });

  test('data: [DONE] → done', () => {
    assert.deepEqual(parseSseLine('data: [DONE]'), { done: true });
  });

  test('服务商错误 → error 文案', () => {
    assert.deepEqual(parseSseLine('data: {"error":{"message":"额度不足"}}'), { error: '额度不足' });
  });

  test('非数据行（注释/心跳/空行）与坏 JSON → undefined（不抛）', () => {
    assert.equal(parseSseLine(': ping'), undefined);
    assert.equal(parseSseLine(''), undefined);
    assert.equal(parseSseLine('event: message'), undefined);
    assert.equal(parseSseLine('data: {半行'), undefined);
  });
});

describe('pickWorkbuddyModel —— 从 WorkBuddy 的 models.json 里挑模型', () => {
  test('挑第一条 id/url/apiKey 齐全的', () => {
    const picked = pickWorkbuddyModel([
      { id: '', url: 'https://x', apiKey: 'k' },
      { id: 'glm-5.3', url: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKey: 'sk-xxx' },
    ]);
    assert.equal(picked?.id, 'glm-5.3');
  });

  test('缺字段 / 不是数组 → undefined', () => {
    assert.equal(pickWorkbuddyModel([{ id: 'a', url: 'https://x' }]), undefined);
    assert.equal(pickWorkbuddyModel(undefined), undefined);
  });
});

describe('workbuddyConfigDir —— 配置根定位', () => {
  test('CODEBUDDY_CONFIG_DIR 优先（WorkBuddy 自己就这么注入）', () => {
    assert.equal(workbuddyConfigDir({ CODEBUDDY_CONFIG_DIR: 'D:/wb' } as NodeJS.ProcessEnv), 'D:/wb');
  });

  test('缺省回落 ~/.workbuddy-ai', () => {
    assert.match(workbuddyConfigDir({} as NodeJS.ProcessEnv), /\.workbuddy-ai$/);
  });
});

describe('loadStandaloneLlmConfig —— 配置优先级', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('用户配置目录里的 standalone-llm.json 可用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-llm-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, 'standalone-llm.json'),
      JSON.stringify({ provider: 'deepseek-official', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: 'deepseek-chat' }),
      'utf8',
    );
    const conf = loadStandaloneLlmConfig({} as NodeJS.ProcessEnv, dir);
    assert.equal(conf?.provider, 'deepseek-official');
    assert.equal(conf?.model, 'deepseek-chat');
    // 缺省值：maxTokens 512、reasoningEffort low
    assert.equal(conf?.maxTokens, 512);
    assert.equal(conf?.reasoningEffort, 'low');
  });

  test('环境变量层：baseUrl + apiKey 齐了才生效', () => {
    // 用不存在的 CODEBUDDY_CONFIG_DIR 关掉"自动发现 WorkBuddy"这一层，让断言不依赖本机装没装 WorkBuddy
    const noWorkbuddy = { CODEBUDDY_CONFIG_DIR: join(tmpdir(), 'dsh-pet-no-such-workbuddy') } as NodeJS.ProcessEnv;
    const env = {
      ...noWorkbuddy,
      DSH_PET_LLM_BASE_URL: 'https://api.deepseek.com',
      DSH_PET_LLM_API_KEY: 'sk-y',
      DSH_PET_LLM_MODEL: 'deepseek-chat',
    } as NodeJS.ProcessEnv;
    const conf = loadStandaloneLlmConfig(env);
    assert.equal(conf?.baseUrl, 'https://api.deepseek.com');
    assert.equal(conf?.model, 'deepseek-chat');
    // 只给 baseUrl 不给 key → 该层视为没配（否则会拿空 key 去请求）；下一层也拿不到东西 → undefined
    assert.equal(
      loadStandaloneLlmConfig({ ...noWorkbuddy, DSH_PET_LLM_BASE_URL: 'https://x' } as NodeJS.ProcessEnv),
      undefined,
    );
  });

  test('reasoningEffort 显式置 null → 不传该字段（空字符串）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-llm-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, 'standalone-llm.json'),
      JSON.stringify({ baseUrl: 'https://x', apiKey: 'k', model: 'm', reasoningEffort: null }),
      'utf8',
    );
    assert.equal(loadStandaloneLlmConfig({} as NodeJS.ProcessEnv, dir)?.reasoningEffort, '');
  });
});

describe('createStandaloneLlm —— 真流式消费（含"一分片多行"回归）', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** 起一个假端点：按给定分片序列吐 SSE，并记录收到的请求体 */
  async function startFakeEndpoint(
    chunks: string[],
  ): Promise<{ baseUrl: string; requests: Array<Record<string, unknown>> }> {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (piece) => (body += piece));
      req.on('end', () => {
        try {
          requests.push(JSON.parse(body));
        } catch {
          requests.push({});
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of chunks) res.write(chunk);
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { baseUrl: `http://127.0.0.1:${port}`, requests };
  }

  const config = (baseUrl: string): StandaloneLlmConfig => ({
    provider: 'test',
    baseUrl,
    apiKey: 'sk-test',
    model: 'test-model',
    maxTokens: 512,
    reasoningEffort: 'low',
    source: 'test',
  });

  /** 消费整条流，返回文本块与终止块 */
  async function consume(llm: ReturnType<typeof createStandaloneLlm>): Promise<{ text: string; finish?: unknown }> {
    let text = '';
    let finish: unknown;
    for await (const chunk of llm.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: '嗨' }] }],
      system: '人设',
      signal: AbortSignal.timeout(10_000),
    })) {
      const typed = chunk as { type?: string; text?: string; finish?: unknown };
      if (typed.type === 'text') text += typed.text ?? '';
      if (typed.type === 'finish') finish = typed.finish;
    }
    return { text, finish };
  }

  test('一分片多行：同批文本块一个都不能丢（长回复被腰斩的回归用例）', async () => {
    // 三段正文挤在**同一个**网络分片里 + 一个终止块——旧实现只会吐出第一段
    const { baseUrl } = await startFakeEndpoint([
      'data: {"choices":[{"delta":{"content":"主人"}}]}\n' +
        'data: {"choices":[{"delta":{"content":"辛苦"}}]}\n' +
        'data: {"choices":[{"delta":{"content":"啦"}}]}\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n' +
        'data: [DONE]\n',
    ]);
    const { text, finish } = await consume(createStandaloneLlm(config(baseUrl)));
    assert.equal(text, '主人辛苦啦');
    assert.deepEqual(finish, { kind: 'stop' });
  });

  test('跨分片断行：半行 JSON 留在缓冲里，拼上后续分片再解析', async () => {
    const { baseUrl } = await startFakeEndpoint([
      'data: {"choices":[{"delta":{"con',
      'tent":"半行"}}]}\n',
      'data: {"choices":[{"delta":{"content":"补上"}}]}\n',
      'data: [DONE]\n',
    ]);
    const { text } = await consume(createStandaloneLlm(config(baseUrl)));
    assert.equal(text, '半行补上');
  });

  test('请求体：带 system、模型、max_tokens 与 reasoning_effort', async () => {
    const { baseUrl, requests } = await startFakeEndpoint(['data: [DONE]\n']);
    await consume(createStandaloneLlm(config(baseUrl)));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'test-model');
    assert.equal(requests[0].max_tokens, 512);
    assert.equal(requests[0].reasoning_effort, 'low');
    assert.equal(requests[0].stream, true);
    assert.deepEqual(requests[0].messages, [
      { role: 'system', content: '人设' },
      { role: 'user', content: '嗨' },
    ]);
  });

  test('reasoningEffort 为空串时不带该字段（服务商不认时会被 400）', async () => {
    const { baseUrl, requests } = await startFakeEndpoint(['data: [DONE]\n']);
    await consume(createStandaloneLlm({ ...config(baseUrl), reasoningEffort: '' }));
    assert.equal('reasoning_effort' in requests[0], false);
  });

  test('finish_reason=length → max-tokens（"思考吃光预算"要报得准）', async () => {
    const { baseUrl } = await startFakeEndpoint(['data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n']);
    const { finish } = await consume(createStandaloneLlm(config(baseUrl)));
    assert.deepEqual(finish, { kind: 'max-tokens' });
  });

  test('HTTP 报错原样带出服务商文案（排障时一眼看到原因）', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"该模型始终思考，不支持关闭思考"}}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await assert.rejects(
      () => consume(createStandaloneLlm(config(`http://127.0.0.1:${port}`))),
      /该模型始终思考/,
    );
  });

  test('流内错误块 → 抛出（上层转成结构化失败，不静默）', async () => {
    const { baseUrl } = await startFakeEndpoint(['data: {"error":{"message":"额度不足"}}\n']);
    await assert.rejects(() => consume(createStandaloneLlm(config(baseUrl))), /额度不足/);
  });

  test('listModels / resolveModelInfo：声明 low/high/max 但**不声明 off**（上游据此省略自己的 effort）', async () => {
    const llm = createStandaloneLlm(config('http://127.0.0.1:1'));
    assert.deepEqual(await llm.listModels(), [{ id: 'test-model', provider: 'test' }]);
    const info = await llm.resolveModelInfo('test', 'test-model');
    assert.deepEqual(
      info.reasoning?.efforts.map((e) => e.id),
      ['low', 'high', 'max'],
    );
  });
});

describe('describeStandaloneLlm —— 日志摘要不含密钥', () => {
  test('摘要含 provider/model/baseUrl/来源，且绝不出现 apiKey', () => {
    const text = describeStandaloneLlm({
      provider: 'workbuddy',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'sk-super-secret',
      model: 'glm-5.3',
      maxTokens: 512,
      reasoningEffort: 'low',
      source: 'models.json',
    });
    assert.match(text, /provider=workbuddy/);
    assert.match(text, /model=glm-5\.3/);
    assert.equal(text.includes('sk-super-secret'), false);
  });
});
