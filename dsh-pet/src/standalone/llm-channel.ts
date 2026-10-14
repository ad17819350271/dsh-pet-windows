/**
 * 独立模式的**模型通道** —— 让碎碎念 / 对话在"没有 DSH"的环境里也能生成。
 *
 * 背景：上游把生成统一收口在 `ctx.llm`（DSH 的 LLM 抽象层）。独立模式原先只提供
 * "明确降级"的替身（`stream` 抛错 → 结构化失败 provider-missing），所以碎碎念/对话不可用。
 * 本文件补上真实现：把 `ctx.llm` 接到一个 **OpenAI 兼容的 chat completions 端点**上，
 * 上游的 `whisper.ts` / `chat.ts` 一行都不用改。
 *
 * 配置来源（优先级从高到低，第一个可用者胜出）：
 *   1. `DSH_PET_LLM_CONFIG` 指向的 JSON 文件（排障/多份配置切换用）
 *   2. `%DSH_HOME%/dsh-pet/standalone-llm.json`（用户可编辑，随宠物配置同处一地）
 *   3. 环境变量 `DSH_PET_LLM_BASE_URL` + `DSH_PET_LLM_API_KEY`（+ `DSH_PET_LLM_MODEL`）
 *   4. **自动发现 WorkBuddy**：读 `%CODEBUDDY_CONFIG_DIR%/models.json`（默认 `~/.workbuddy-ai/models.json`），
 *      取其中第一条模型配置——等于复用用户已经在 WorkBuddy 里配好的模型与凭证，零额外配置。
 *
 * 关于 `reasoningEffort`（实测结论，2026-10-14，GLM Coding Plan 端点）：
 *   - `glm-5.3` 属"始终思考"的模型，**不接受关闭思考**（传 `thinking:{type:disabled}` → 400，
 *     报文原话：「该模型始终思考，不支持关闭思考；请使用 low、high 或 max」）；
 *   - 而传 `reasoning_effort: 'low'` 时思考 token 归零、1.1s 出正文（默认 effort 会先烧掉
 *     数百个 reasoning token，`max_tokens` 给小了会拿到空 content —— 这正是最容易踩的坑）；
 *   - 因此本通道**默认带 `reasoning_effort: 'low'`**，并把 `max_tokens` 设到 512 起步。
 *   上游的 `supportsReasoningOff` 探测走 `resolveModelInfo`：我们**不声明 'off'**，
 *   于是上游省略它自己的 reasoningEffort 字段，由本通道的默认值兜住（语义：通道自己知道该传什么）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 通道配置（一次解析、多处使用） */
export interface StandaloneLlmConfig {
  /** provider id：既用于模型通道，也用于余额路由匹配（如 `deepseek-official` 能直接查到余额） */
  provider: string;
  /** OpenAI 兼容端点基址（不带 `/chat/completions`） */
  baseUrl: string;
  apiKey: string;
  /** 默认模型 id */
  model: string;
  /** 单次请求的 max_tokens（缺省 512） */
  maxTokens: number;
  /** 透传给服务商的 reasoning_effort（缺省 'low'；空字符串 = 不传） */
  reasoningEffort: string;
  /** 配置来源（日志/体检里显示，便于用户知道"用的是哪份配置"） */
  source: string;
}

/** 上游 dsh-llm 的消息形状（本通道只关心角色与文本块） */
interface LlmMessageLike {
  role?: unknown;
  content?: unknown;
}

/** `stream()` 的入参（与 DSH 的 LlmStreamOptions 对齐，宽松读取） */
export interface LlmStreamOptionsLike {
  provider?: unknown;
  model?: unknown;
  messages?: unknown;
  system?: unknown;
  signal?: AbortSignal;
  maxTokens?: unknown;
}

/** WorkBuddy 的 models.json 条目（只取用得到的字段） */
interface WorkbuddyModelEntry {
  id?: unknown;
  url?: unknown;
  apiKey?: unknown;
}

/** 默认 max_tokens：够写一句碎碎念/一段闲聊，又不至于让"始终思考"的模型烧太久 */
const DEFAULT_MAX_TOKENS = 512;
/** 默认 reasoning effort：实测 low 会让思考 token 归零、响应 1 秒级 */
const DEFAULT_REASONING_EFFORT = 'low';

/** 展开一个 content 字段（字符串 / 文本块数组）为纯文本 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

/**
 * 把 dsh-llm 的消息数组 + system 折成 OpenAI 的 messages。
 * 非 user/assistant 的角色（工具消息等）在独立模式不会出现，防御性跳过。
 */
export function flattenMessages(
  messages: unknown,
  system: unknown,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (typeof system === 'string' && system.trim() !== '') out.push({ role: 'system', content: system });
  if (Array.isArray(messages)) {
    for (const raw of messages as LlmMessageLike[]) {
      const role = raw?.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
      const content = contentToText(raw?.content);
      if (content === '') continue;
      out.push({ role, content });
    }
  }
  return out;
}

/**
 * 解析一行 SSE：`data: {...}` / `data: [DONE]` → 增量文本与终止原因。
 * @returns undefined = 这一行不是数据行（注释、空行、`event:` 等）
 */
export function parseSseLine(
  line: string,
): { text?: string; done?: boolean; finishReason?: string; error?: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '[DONE]') return { done: true };
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return undefined; // 半行/心跳：交给下一块拼接后再解析
  }
  const obj = body as { error?: { message?: unknown }; choices?: unknown };
  if (obj?.error) {
    const message = obj.error.message;
    return { error: typeof message === 'string' ? message : JSON.stringify(obj.error) };
  }
  const choice = Array.isArray(obj?.choices) ? (obj.choices[0] as Record<string, unknown>) : undefined;
  const delta = choice?.delta as { content?: unknown } | undefined;
  const text = typeof delta?.content === 'string' ? delta.content : undefined;
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
  if (text === undefined && finishReason === undefined) return undefined;
  return { text, finishReason };
}

/** 从 WorkBuddy 的 models.json 里挑一条可用模型（第一条 url+apiKey+id 齐全的） */
export function pickWorkbuddyModel(entries: unknown): WorkbuddyModelEntry | undefined {
  if (!Array.isArray(entries)) return undefined;
  return (entries as WorkbuddyModelEntry[]).find(
    (entry) =>
      entry &&
      typeof entry.id === 'string' &&
      typeof entry.url === 'string' &&
      typeof entry.apiKey === 'string' &&
      entry.id !== '' &&
      entry.url !== '' &&
      entry.apiKey !== '',
  );
}

/** WorkBuddy 配置根：`CODEBUDDY_CONFIG_DIR` 优先（WorkBuddy 自己就这么注入），否则 `~/.workbuddy-ai` */
export function workbuddyConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CODEBUDDY_CONFIG_DIR;
  if (typeof dir === 'string' && dir.trim() !== '') return dir;
  return join(homedir(), '.workbuddy-ai');
}

/** 读 JSON 文件，失败返回 undefined（配置缺失/损坏都不该让独立模式起不来） */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 从一份用户配置对象里读通道配置（字段缺省/类型不对一律回落） */
function fromUserConfig(raw: unknown, source: string): StandaloneLlmConfig | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const conf = raw as Record<string, unknown>;
  const baseUrl = typeof conf.baseUrl === 'string' ? conf.baseUrl.trim() : '';
  const apiKey = typeof conf.apiKey === 'string' ? conf.apiKey.trim() : '';
  const model = typeof conf.model === 'string' ? conf.model.trim() : '';
  if (baseUrl === '' || apiKey === '' || model === '') return undefined;
  const provider = typeof conf.provider === 'string' && conf.provider.trim() !== '' ? conf.provider.trim() : 'custom';
  const maxTokens = Number(conf.maxTokens);
  const effort = conf.reasoningEffort;
  return {
    provider,
    baseUrl,
    apiKey,
    model,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS,
    reasoningEffort:
      typeof effort === 'string' ? effort.trim() : effort === null ? '' : DEFAULT_REASONING_EFFORT,
    source,
  };
}

/**
 * 解析通道配置（优先级见文件头）。全部落空 → undefined（调用方据此走"明确降级"）。
 * @param env 环境变量（测试可注入）
 * @param home 用户主目录下的 dsh-pet 配置目录（测试可注入）
 */
export function loadStandaloneLlmConfig(
  env: NodeJS.ProcessEnv = process.env,
  userConfigDir?: string,
): StandaloneLlmConfig | undefined {
  // 1. 显式配置文件
  const explicit = env.DSH_PET_LLM_CONFIG;
  if (typeof explicit === 'string' && explicit.trim() !== '' && existsSync(explicit)) {
    const conf = fromUserConfig(readJson(explicit), `DSH_PET_LLM_CONFIG=${explicit}`);
    if (conf) return conf;
  }

  // 2. 用户配置目录里的 standalone-llm.json
  if (userConfigDir) {
    const path = join(userConfigDir, 'standalone-llm.json');
    if (existsSync(path)) {
      const conf = fromUserConfig(readJson(path), path);
      if (conf) return conf;
    }
  }

  // 3. 环境变量
  const envBase = typeof env.DSH_PET_LLM_BASE_URL === 'string' ? env.DSH_PET_LLM_BASE_URL.trim() : '';
  const envKey = typeof env.DSH_PET_LLM_API_KEY === 'string' ? env.DSH_PET_LLM_API_KEY.trim() : '';
  if (envBase !== '' && envKey !== '') {
    return fromUserConfig(
      {
        provider: env.DSH_PET_LLM_PROVIDER ?? 'custom',
        baseUrl: envBase,
        apiKey: envKey,
        model: env.DSH_PET_LLM_MODEL ?? 'deepseek-chat',
        maxTokens: env.DSH_PET_LLM_MAX_TOKENS,
        reasoningEffort: env.DSH_PET_LLM_REASONING_EFFORT,
      },
      'DSH_PET_LLM_* 环境变量',
    );
  }

  // 4. 自动发现 WorkBuddy 的模型配置
  const wbPath = join(workbuddyConfigDir(env), 'models.json');
  if (existsSync(wbPath)) {
    const picked = pickWorkbuddyModel(readJson(wbPath));
    if (picked) {
      return {
        provider: 'workbuddy',
        baseUrl: String(picked.url),
        apiKey: String(picked.apiKey),
        model: String(picked.id),
        maxTokens: DEFAULT_MAX_TOKENS,
        reasoningEffort: DEFAULT_REASONING_EFFORT,
        source: wbPath + '（WorkBuddy 已配置的模型）',
      };
    }
  }

  return undefined;
}

/** 通道对外形状（与 DSH 的 ctx.llm 契约对齐；独立模式只用得到这四个成员） */
export interface StandaloneLlm {
  listProviders(): Array<{ id: string }>;
  listModels(): Promise<Array<{ id: string; provider: string }>>;
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ reasoning?: { efforts: Array<{ id: string }> } }>;
  stream(options: LlmStreamOptionsLike): AsyncIterable<unknown>;
}

/**
 * 建一个接到 OpenAI 兼容端点的 `ctx.llm` 替身。
 *
 * 契约要点（与 DSH 一致，踩过的坑写在 context.ts 的同名注释里）：
 *   - `stream()` **必须**返回 AsyncIterable（不是 Promise），调用方一律 `for await`；
 *   - 失败在首次 `next()` 抛出，落进调用方已有的 try/catch → `generate-error` + 真实原因；
 *   - 终止原因经 `{ type: 'finish' }` 块交给 BlockAssembler，供 `noTextReason()` 出准确文案
 *     （典型：`max-tokens` → "输出达到上限，未产出正文"，正是"思考吃光预算"的表现）。
 */
export function createStandaloneLlm(config: StandaloneLlmConfig): StandaloneLlm {
  return {
    listProviders: () => [{ id: config.provider }],
    listModels: async () => [{ id: config.model, provider: config.provider }],
    // 只声明 low/high/max：**不声明 'off'**，让上游省略它自己的 reasoningEffort，
    // 由本通道的默认值（low）兜住——该端点不接受"关闭思考"（见文件头实测记录）。
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } }),

    stream(options: LlmStreamOptionsLike): AsyncIterable<unknown> {
      const messages = flattenMessages(options?.messages, options?.system);
      const maxTokens =
        Number.isFinite(Number(options?.maxTokens)) && Number(options?.maxTokens) > 0
          ? Math.floor(Number(options?.maxTokens))
          : config.maxTokens;
      const url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';
      const payload: Record<string, unknown> = {
        model: typeof options?.model === 'string' && options.model !== '' ? options.model : config.model,
        messages,
        max_tokens: maxTokens,
        stream: true,
      };
      if (config.reasoningEffort !== '') payload.reasoning_effort = config.reasoningEffort;

      return {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          /** 惰性启动：真正的 fetch 发生在第一次 next()，错误因此落在调用方的 try/catch 里 */
          let started: Promise<{ body: ReadableStream<Uint8Array>; abort: AbortController }> | undefined;
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let buffer = '';
          let finished = false;
          /**
           * 待发队列：**一个网络分片里通常有多行 SSE**，而 `next()` 一次只能交出一个块。
           * 必须把同批解析出的块排进队列逐个交付——早期版本直接 return 第一个文本块、
           * 丢掉同批其余行，表现为"长回复被腰斩"（碎碎念短，一直没暴露）。
           */
          const pending: Array<{ type: 'text'; text: string } | { type: 'finish'; finish: unknown } | { type: 'done' }> =
            [];

          const start = async (): Promise<{ body: ReadableStream<Uint8Array>; abort: AbortController }> => {
            const abort = new AbortController();
            if (options?.signal) {
              if (options.signal.aborted) abort.abort();
              else options.signal.addEventListener('abort', () => abort.abort(), { once: true });
            }
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + config.apiKey,
              },
              body: JSON.stringify(payload),
              signal: abort.signal,
            });
            if (!response.ok) {
              // 把服务商的报错原样带出来（例如 GLM 的「该模型始终思考…」），排障时一眼看到原因
              let detail = '';
              try {
                detail = (await response.text()).slice(0, 300);
              } catch {
                /* 读不到正文就只报状态码 */
              }
              throw new Error(`模型通道 HTTP ${response.status}${detail ? '：' + detail : ''}`);
            }
            if (!response.body) throw new Error('模型通道：响应没有正文流');
            return { body: response.body, abort };
          };

          return {
            next: async (): Promise<IteratorResult<unknown>> => {
              for (;;) {
                // 先把上一批解析出的块交完，再读网络
                const item = pending.shift();
                if (item) {
                  if (item.type === 'done') {
                    finished = true;
                    return { done: true, value: undefined };
                  }
                  if (item.type === 'text') return { done: false, value: { type: 'text', text: item.text } };
                  return { done: false, value: { type: 'finish', finish: item.finish } };
                }
                if (finished) return { done: true, value: undefined };

                if (!started) started = start();
                if (!reader) reader = (await started).body.getReader();
                const { done, value } = await reader.read();
                if (done) {
                  finished = true;
                  return { done: true, value: undefined };
                }
                buffer += new TextDecoder().decode(value, { stream: true });
                // SSE 以换行分隔事件；逐行消费，残留半行留在 buffer 里等下一块
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                  const parsed = parseSseLine(line);
                  if (!parsed) continue;
                  if (parsed.error) {
                    finished = true;
                    throw new Error('模型通道返回错误：' + parsed.error);
                  }
                  if (parsed.text !== undefined && parsed.text !== '') pending.push({ type: 'text', text: parsed.text });
                  if (parsed.finishReason !== undefined) {
                    // 终止块：上游 BlockAssembler 据此给出"输出达到上限"这类准确文案
                    const kind =
                      parsed.finishReason === 'length'
                        ? 'max-tokens'
                        : parsed.finishReason === 'stop'
                          ? 'stop'
                          : parsed.finishReason;
                    pending.push({ type: 'finish', finish: { kind } });
                  }
                  if (parsed.done) pending.push({ type: 'done' });
                }
              }
            },
            return: async (): Promise<IteratorResult<unknown>> => {
              // 调用方提前退出（超时 abort / 出错）时释放连接
              finished = true;
              try {
                await reader?.cancel();
              } catch {
                /* 已经断了就算了 */
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
}

/** 日志用：通道摘要（**绝不打印 apiKey**） */
export function describeStandaloneLlm(config: StandaloneLlmConfig): string {
  return `provider=${config.provider} model=${config.model} baseUrl=${config.baseUrl} 来源=${config.source}`;
}
