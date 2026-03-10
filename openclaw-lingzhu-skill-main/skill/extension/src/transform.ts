import type {
  LingzhuMessage,
  LingzhuContext,
  LingzhuSSEData,
  LingzhuToolCall,
} from "./types.js";

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | { type: string; image_url?: { url: string } }[];
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  index?: number;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
}

interface LingzhuTransformOptions {
  systemPrompt?: string;
  defaultNavigationMode?: "0" | "1" | "2";
  enableExperimentalNativeActions?: boolean;
}

function resolveNavigationMode(
  value: unknown,
  fallback: "0" | "1" | "2" = "0"
): "0" | "1" | "2" {
  return value === "1" || value === "2" ? value : fallback;
}

function createDefaultSystemPrompt(enableExperimentalNativeActions = false): string {
  const lines = [
    "你是灵珠设备桥接助手，需要优先把用户意图转换成设备工具调用。",
    "当用户要求拍照、照相、记录眼前画面时，必须调用 take_photo。",
    "当用户要求导航、带路、去某地时，必须调用 navigate，并尽量补充 destination。",
    "当用户要求设置提醒、创建日程、添加行程时，必须调用 calendar。",
    "当用户要求退出、结束当前智能体会话时，必须调用 exit_agent。",
    "不要把工具调用伪装成普通文本说明；能调用工具时优先调用工具。",
  ];

  if (enableExperimentalNativeActions) {
    lines.push("当用户要求发送眼镜通知时，调用 send_notification。");
    lines.push("当用户要求发送短提示或轻提示时，调用 send_toast。");
    lines.push("当用户要求眼镜直接播报文本时，调用 speak_tts。");
    lines.push("当用户要求开始录像时，调用 start_video_record；停止录像时调用 stop_video_record。");
    lines.push("当用户要求打开自定义页面或展示实验 UI 时，调用 open_custom_view。");
  }

  return lines.join("\n");
}

function resolveToolCommand(
  toolName: string,
  options: LingzhuTransformOptions = {}
): string | null {
  const command = TOOL_COMMAND_MAP[toolName.toLowerCase()] ?? null;
  if (!command) {
    return null;
  }

  const experimentalCommands = new Set([
    "send_notification",
    "send_toast",
    "speak_tts",
    "start_video_record",
    "stop_video_record",
    "open_custom_view",
  ]);

  if (experimentalCommands.has(command) && options.enableExperimentalNativeActions !== true) {
    return null;
  }

  return command;
}

/**
 * 工具调用累积器 - 处理流式 tool_calls 参数分片
 */
export class ToolCallAccumulator {
  private tools: Map<number, { id: string; name: string; arguments: string }> = new Map();

  /**
   * 累积工具调用片段
   */
  accumulate(toolCalls: OpenAIToolCall[]): void {
    for (const tc of toolCalls) {
      const index = tc.index ?? 0;

      if (!this.tools.has(index)) {
        this.tools.set(index, {
          id: tc.id || "",
          name: tc.function?.name || "",
          arguments: "",
        });
      }

      const existing = this.tools.get(index)!;
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
    }
  }

  /**
   * 获取完整的工具调用（当流结束时）
   */
  getCompleted(): Array<{ id: string; name: string; arguments: string }> {
    return Array.from(this.tools.values()).filter(t => t.name);
  }

  /**
   * 检查是否有任何工具调用
   */
  hasTools(): boolean {
    return this.tools.size > 0;
  }

  /**
   * 清空累积器
   */
  clear(): void {
    this.tools.clear();
  }
}

/**
 * 灵珠设备命令映射表
 * 将 OpenClaw 工具名称映射到灵珠设备命令
 */
const TOOL_COMMAND_MAP: Record<string, string> = {
  // 拍照相关
  take_photo: "take_photo",
  camera: "take_photo",
  photo: "take_photo",
  takepicture: "take_photo",
  snapshot: "take_photo",

  // 导航相关
  navigate: "take_navigation",
  navigation: "take_navigation",
  take_navigation: "take_navigation",
  maps: "take_navigation",
  route: "take_navigation",
  directions: "take_navigation",

  // 日程相关
  calendar: "control_calendar",
  add_calendar: "control_calendar",
  control_calendar: "control_calendar",
  schedule: "control_calendar",
  reminder: "control_calendar",
  add_reminder: "control_calendar",
  create_event: "control_calendar",
  set_schedule: "control_calendar",

  // 退出智能体
  exit: "notify_agent_off",
  quit: "notify_agent_off",
  notify_agent_off: "notify_agent_off",
  close_agent: "notify_agent_off",
  leave_agent: "notify_agent_off",

  // 实验性原生动作
  send_notification: "send_notification",
  notification: "send_notification",
  notify: "send_notification",
  send_toast: "send_toast",
  toast: "send_toast",
  speak_tts: "speak_tts",
  tts: "speak_tts",
  speak: "speak_tts",
  start_video_record: "start_video_record",
  start_recording: "start_video_record",
  record_video: "start_video_record",
  stop_video_record: "stop_video_record",
  stop_recording: "stop_video_record",
  open_custom_view: "open_custom_view",
  custom_view: "open_custom_view",
  show_view: "open_custom_view",
};

/**
 * 特殊标记正则 - 解析工具返回的 LINGZHU_TOOL_CALL 标记
 * 格式: <LINGZHU_TOOL_CALL:command:params_json>
 */
const LINGZHU_TOOL_MARKER_REGEX = /<LINGZHU_TOOL_CALL:(\w+):(\{[^}]*\})>/;

/**
 * 从文本回复中检测灵珠设备命令
 * 优先解析特殊标记，其次使用模式匹配
 */
export function detectIntentFromText(
  text: string,
  options: LingzhuTransformOptions = {}
): LingzhuSSEData["tool_call"] | null {
  const defaultNavigationMode = resolveNavigationMode(options.defaultNavigationMode);
  const experimentalEnabled = options.enableExperimentalNativeActions === true;

  // 1. 优先解析特殊标记 (来自我们注册的工具)
  const markerMatch = text.match(LINGZHU_TOOL_MARKER_REGEX);
  if (markerMatch) {
    const command = markerMatch[1] as LingzhuToolCall["command"];
    const experimentalCommands = new Set([
      "send_notification",
      "send_toast",
      "speak_tts",
      "start_video_record",
      "stop_video_record",
      "open_custom_view",
    ]);
    if (experimentalCommands.has(command) && !experimentalEnabled) {
      return null;
    }
    const paramsStr = markerMatch[2];

    let rawParams: Record<string, unknown> = {};
    try {
      rawParams = JSON.parse(paramsStr);
    } catch {
      rawParams = {};
    }

    // 根据命令类型构建 tool_call (使用新结构)
    const toolCall: LingzhuToolCall = {
      handling_required: true,
      command: command,
      params: {
        is_recall: true,
      },
    };

    // 填充参数
    if (command === "take_navigation") {
      toolCall.params.action = "open";
      if (rawParams.destination) toolCall.params.poi_name = rawParams.destination as string;
      toolCall.params.navi_type = resolveNavigationMode(rawParams.navi_type, defaultNavigationMode);
    } else if (command === "control_calendar") {
      toolCall.params.action = "create";
      if (rawParams.title) toolCall.params.title = rawParams.title as string;
      if (rawParams.start_time) toolCall.params.start_time = rawParams.start_time as string;
      if (rawParams.end_time) toolCall.params.end_time = rawParams.end_time as string;
    } else if (command === "send_notification" || command === "send_toast" || command === "speak_tts") {
      if (rawParams.content) toolCall.params.content = rawParams.content as string;
      if (typeof rawParams.play_tts === "boolean") toolCall.params.play_tts = rawParams.play_tts;
      if (rawParams.icon_type) toolCall.params.icon_type = String(rawParams.icon_type);
    } else if (command === "start_video_record") {
      if (typeof rawParams.duration_sec === "number") toolCall.params.duration_sec = rawParams.duration_sec;
      if (typeof rawParams.width === "number") toolCall.params.width = rawParams.width;
      if (typeof rawParams.height === "number") toolCall.params.height = rawParams.height;
      if (typeof rawParams.quality === "number") toolCall.params.quality = rawParams.quality;
    } else if (command === "open_custom_view") {
      if (rawParams.view_name) toolCall.params.view_name = rawParams.view_name as string;
      if (rawParams.view_payload) toolCall.params.view_payload = String(rawParams.view_payload);
    }

    return toolCall;
  }

  // 2. 备用：文本模式匹配（覆盖各种 AI 回复方式）
  const patterns: Array<{ regex: RegExp; command: LingzhuToolCall["command"] }> = [
    // 拍照相关
    { regex: /正在.*拍照/, command: "take_photo" },
    { regex: /帮.*拍.*照/, command: "take_photo" },
    { regex: /拍照.*已提交/, command: "take_photo" },
    { regex: /拍照.*完成/, command: "take_photo" },
    { regex: /已.*拍照/, command: "take_photo" },
    { regex: /通过.*拍照/, command: "take_photo" },
    { regex: /照片.*发/, command: "take_photo" },
    { regex: /拍.*照片/, command: "take_photo" },
    // 退出相关
    { regex: /退出.*智能体/, command: "notify_agent_off" },
    { regex: /结束.*对话/, command: "notify_agent_off" },
  ];

  if (experimentalEnabled) {
    patterns.push({ regex: /发送.*通知/, command: "send_notification" });
    patterns.push({ regex: /显示.*toast|弹出.*提示/, command: "send_toast" });
    patterns.push({ regex: /播报|朗读|语音提示/, command: "speak_tts" });
    patterns.push({ regex: /开始.*录像|录一段视频/, command: "start_video_record" });
    patterns.push({ regex: /停止.*录像|结束录像/, command: "stop_video_record" });
    patterns.push({ regex: /打开.*页面|显示.*页面|展示.*页面/, command: "open_custom_view" });
  }

  for (const p of patterns) {
    if (p.regex.test(text)) {
      return {
        handling_required: true,
        command: p.command,
        params: { is_recall: true },
      };
    }
  }

  const navigationMatch = text.match(/(?:导航|前往|去往|带你去|正在前往)(?:到)?[:：]?\s*([^\n，。]+)/);
  if (navigationMatch?.[1]) {
    return {
      handling_required: true,
      command: "take_navigation",
      params: {
        is_recall: true,
        action: "open",
        poi_name: navigationMatch[1].trim(),
        navi_type: defaultNavigationMode,
      },
    };
  }

  return null;
}

/**
 * 将灵珠消息格式转换为 OpenAI messages 格式
 */
export function lingzhuToOpenAI(
  messages: LingzhuMessage[],
  context?: LingzhuContext,
  options: LingzhuTransformOptions = {}
): OpenAIMessage[] {
  const openaiMessages: OpenAIMessage[] = [];
  const systemParts: string[] = [createDefaultSystemPrompt(options.enableExperimentalNativeActions === true)];

  if (options.systemPrompt) {
    systemParts.push(options.systemPrompt);
  }

  if (systemParts.length > 0) {
    openaiMessages.push({
      role: "system",
      content: systemParts.join("\n\n"),
    });
  }

  // 如果有设备上下文信息，添加为 system 消息
  if (context) {
    const parts: string[] = [];
    if (context.currentTime) parts.push(`当前时间: ${context.currentTime}`);
    if (context.location) parts.push(`位置: ${context.location}`);
    if (context.weather) parts.push(`天气: ${context.weather}`);
    if (context.battery) parts.push(`电量: ${context.battery}%`);
    if (context.latitude && context.longitude) {
      parts.push(`坐标: ${context.latitude}, ${context.longitude}`);
    }
    if (context.lang) parts.push(`语言: ${context.lang}`);
    if (context.runningApp) parts.push(`当前运行应用: ${context.runningApp}`);

    if (parts.length > 0) {
      openaiMessages.push({
        role: "system",
        content: `[rokid glasses信息]\n${parts.join("\n")}`,
      });
    }
  }


  // 转换消息
  for (const msg of messages) {
    const role = msg.role === "agent" ? "assistant" : "user";

    if (msg.type === "text" && msg.text) {
      openaiMessages.push({ role, content: msg.text });
    } else if (msg.type === "text" && msg.content) {
      openaiMessages.push({ role, content: msg.content });
    } else if (msg.type === "image" && msg.image_url) {
      openaiMessages.push({
        role,
        content: [{ type: "image_url", image_url: { url: msg.image_url } }],
      });
    }
  }

  return openaiMessages;
}

/**
 * 解析工具调用参数并转换为灵珠 tool_call 格式
 * （用于内部和从累积器解析）
 */
export function parseToolCallFromAccumulated(
  toolName: string,
  argsStr: string,
  options: LingzhuTransformOptions = {}
): LingzhuSSEData["tool_call"] | null {
  const defaultNavigationMode = resolveNavigationMode(options.defaultNavigationMode);
  const command = resolveToolCommand(toolName, options);
  if (!command) {
    return null;
  }

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsStr || "{}");
  } catch {
    args = {};
  }

  const toolCall: LingzhuToolCall = {
    handling_required: true,
    command: command as LingzhuToolCall["command"],
    params: {
      is_recall: true,
    },
  };

  // 根据命令类型填充参数
  switch (command) {
    case "take_navigation":
      toolCall.params.action = (args.action as string) || "open";
      if (args.destination || args.poi_name || args.address) {
        toolCall.params.poi_name = (args.destination || args.poi_name || args.address) as string;
      }
      toolCall.params.navi_type = resolveNavigationMode(args.navi_type ?? args.type, defaultNavigationMode);
      break;

    case "control_calendar":
      toolCall.params.action = (args.action as string) || "create";
      if (args.title) toolCall.params.title = args.title as string;
      if (args.start_time || args.startTime) {
        toolCall.params.start_time = (args.start_time || args.startTime) as string;
      }
      if (args.end_time || args.endTime) {
        toolCall.params.end_time = (args.end_time || args.endTime) as string;
      }
      break;

    case "send_notification":
    case "send_toast":
    case "speak_tts":
      if (args.content) toolCall.params.content = String(args.content);
      if (typeof args.play_tts === "boolean") toolCall.params.play_tts = args.play_tts;
      if (args.icon_type) toolCall.params.icon_type = String(args.icon_type);
      break;

    case "start_video_record":
      if (typeof args.duration_sec === "number") toolCall.params.duration_sec = args.duration_sec;
      if (typeof args.width === "number") toolCall.params.width = args.width;
      if (typeof args.height === "number") toolCall.params.height = args.height;
      if (typeof args.quality === "number") toolCall.params.quality = args.quality;
      break;

    case "open_custom_view":
      if (args.view_name) toolCall.params.view_name = String(args.view_name);
      if (args.view_payload) toolCall.params.view_payload = JSON.stringify(args.view_payload);
      break;
  }

  return toolCall;
}

/**
 * 将 OpenAI SSE chunk 转换为灵珠 SSE 格式
 */
export function openaiChunkToLingzhu(
  chunk: OpenAIChunk,
  messageId: string,
  agentId: string,
  options: LingzhuTransformOptions = {}
): LingzhuSSEData {
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  const content = delta?.content || "";
  const isFinish = choice?.finish_reason != null;
  const toolCalls = delta?.tool_calls;

  // 检查是否有工具调用
  if (toolCalls && toolCalls.length > 0) {
    const tc = toolCalls[0];
    if (tc.function?.name) {
      const parsedToolCall = parseToolCallFromAccumulated(
        tc.function.name,
        tc.function.arguments || "{}",
        options
      );

      if (parsedToolCall) {
        return {
          role: "agent",
          type: "tool_call",
          message_id: messageId,
          agent_id: agentId,
          is_finish: isFinish,
          tool_call: parsedToolCall,
        };
      }
    }
  }

  // 普通文本回答
  return {
    role: "agent",
    type: "answer",
    answer_stream: content,
    message_id: messageId,
    agent_id: agentId,
    is_finish: isFinish,
  };
}

/**
 * 创建 follow_up 类型的响应
 */
export function createFollowUpResponse(
  suggestions: string[],
  messageId: string,
  agentId: string
): LingzhuSSEData {
  return {
    role: "agent",
    type: "follow_up",
    message_id: messageId,
    agent_id: agentId,
    is_finish: true,
    follow_up: suggestions,
  };
}

/**
 * 从文本中提取 follow_up 建议
 * 检测类似 "你还可以问我：1. xxx 2. xxx" 的模式
 */
export function extractFollowUpFromText(text: string, limit = 3): string[] | null {
  // 匹配常见的建议问题模式
  const patterns = [
    /你(?:还)?可以(?:问我|尝试|试试)[：:]\s*(.+)/,
    /(?:推荐|建议)(?:问题|提问)[：:]\s*(.+)/,
    /(?:相关|更多)问题[：:]\s*(.+)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const suggestions = match[1]
        .split(/[,，;；\n]|(?:\d+[.、)])/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length < 100);

      if (suggestions.length > 0) {
        return suggestions.slice(0, Math.max(0, limit));
      }
    }
  }

  return null;
}

/**
 * 构造灵珠 SSE 事件字符串
 */
export function formatLingzhuSSE(
  event: "message" | "done",
  data: LingzhuSSEData | string
): string {
  const dataStr = typeof data === "string" ? data : JSON.stringify(data);
  return `event:${event}\ndata:${dataStr}\n\n`;
}
