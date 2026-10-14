/**
 * `@deepseek-ai/dsh-llm` 的独立模式替身（消息工厂 / 文本块拼装 / reasoning 标识）。
 *
 * 独立模式没有模型后端。`ctx.llm` 的替身（见 ../context.ts）让**没有显式配置模型**的调用在
 * 候选链阶段就失败：`agentDefaultModel.currentSelection()` 返回的 model 为空 →
 * `model-selection.ts` 的 `currentModel()` 判定为「未配置」→ `generateWhisper` / `generateChat`
 * 直接回 `{ ok: false, reason: 'provider-missing' }`。
 *
 * **但这不是结构性保证。** 用户在配置里显式写了 `whisperModel` / `chatModel`（设置页选过模型
 * 就会写进配置）时，候选链非空，生成侧会真的走到本文件的消息构造与 `ctx.llm.stream`。
 * 所以本文件与 ctx.llm 替身的每一处形状都必须与 DSH 的真实契约一致 —— 0.3.4 的崩溃正是因为
 * `stream` 被当成"永远不走的那条路"，实现成返回 Promise 而契约要求 AsyncIterable
 * （细节见 ../context.ts 里 stream / resolveModelInfo 的注释）。
 *
 * 那为什么还要实现它们：`whisper.ts` / `chat.ts` 是**静态 import** 这四个名字的，
 * 模块图能加载是独立模式起得来的前提；同时保持它们是纯本地、零网络的实现，
 * 将来若有人给独立模式接上模型通道（例如自带 API key），这条路径可以照常工作。
 *
 * 只在独立模式构建里生效：`tsdown.config.mjs` 用 alias 把该包名指向本文件。
 */

/** 消息的最小形状（只有角色、内容与来源标记；适配器回放不在独立模式范围内） */
export interface StandaloneLlmMessage {
  role: 'user' | 'assistant';
  content: unknown;
  source: unknown;
}

/** 用户消息（`whisper.ts` / `chat.ts` 的入参形状） */
export function createUserMessage(input: { content: unknown; source: unknown }): StandaloneLlmMessage {
  return { role: 'user', content: input.content, source: input.source };
}

/** 助手消息（`chat.ts` 回放历史用） */
export function createAssistantMessage(input: { content: unknown; source: unknown }): StandaloneLlmMessage {
  return { role: 'assistant', content: input.content, source: input.source };
}

/** 文本块（`BlockAssembler.blocks()` 的元素形状） */
export interface StandaloneTextBlock {
  type: 'text';
  text: string;
}

/**
 * 流式文本拼装：收集文本块 + 记录终止块（与调用方
 * `blocks().filter(b => b.type === 'text')` 和 `noTextReason(assembler.finish)` 的用法一致）。
 *
 * 为什么要有 `finish`：调用方在没有正文时会读 `assembler.finish` 给出**准确**原因
 * （`noTextReason` 认 `max-tokens` / `aborted` / `error`）。独立模式的模型通道会 yield
 * `{ type: 'finish', finish: { kind } }`（见 ../llm-channel.ts），这里必须接住它，
 * 否则"模型思考吃光了 token 预算"只会显示成笼统的"模型未返回文本"。
 */
export class BlockAssembler {
  private readonly chunks: string[] = [];
  /** 终止信息（最后一个终止块胜出；DSH 侧语义相同） */
  finish: { kind?: string; failure?: unknown } | undefined;

  /** 收集一个块；文本块入正文，终止块记原因，其余（工具调用等）在独立模式下忽略 */
  push(chunk: unknown): void {
    if (chunk === null || typeof chunk !== 'object') return;
    const typed = chunk as { type?: unknown; text?: unknown; finish?: unknown };
    if (typed.type === 'text') {
      if (typeof typed.text === 'string') this.chunks.push(typed.text);
      return;
    }
    if (typed.type === 'finish') {
      const finish = typed.finish;
      this.finish =
        finish !== null && typeof finish === 'object'
          ? (finish as { kind?: string; failure?: unknown })
          : { kind: typeof finish === 'string' ? finish : undefined };
    }
  }

  /** 当前已拼装的块列表 */
  blocks(): StandaloneTextBlock[] {
    const text = this.chunks.join('');
    return text === '' ? [] : [{ type: 'text', text }];
  }
}

/** reasoning effort 标识工厂（DSH 侧是枚举工厂，这里保持"传什么就是什么"） */
export function ReasoningEffortId(id: string): string {
  return id;
}
