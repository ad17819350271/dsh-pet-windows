/**
 * workbuddy-hook.mjs 的类型声明（脚本本身是运行时产物，不参与 TS 编译；
 * 测试与消费者按这份声明取类型）。
 */

/** 投影后的结构事件（**只含结构字段**：含内容的字段一律不进这里） */
export interface ProjectedEvent {
  /** hook 事件名（Stop / PermissionRequest / Notification / …） */
  event: string;
  /** 投影时刻（ms） */
  ts: number;
  session_id?: string;
  tool_name?: string;
  permission_mode?: string;
  notification_type?: string;
  /** 仅 Stop 事件：回复是否以问句结尾（只是布尔，不保留正文） */
  ends_with_question?: boolean;
}

/** 与 shared/notify.ts 同契约的通知帧 */
export interface NotifyFrameLike {
  type: string;
  [key: string]: unknown;
}

/** 回复是否以问句结尾（只产出一个布尔） */
export declare function endsWithQuestion(text: unknown): boolean;

/** 把 hook payload 投影成只含结构字段的事件 */
export declare function project(event: string, payload: unknown): ProjectedEvent;

/** 投影事件 → 通知帧；undefined = 该事件不产生通知 */
export declare function toNotifyFrame(projected: ProjectedEvent): NotifyFrameLike | undefined;

/** POST 一帧到桌宠；任何失败都返回 false（fail-open） */
export declare function postFrame(
  frame: NotifyFrameLike,
  ports?: number[],
  timeoutMs?: number,
): Promise<boolean>;
