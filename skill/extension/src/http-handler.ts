import type { IncomingMessage, ServerResponse } from "node:http";
import type { LingzhuRequest, LingzhuConfig, LingzhuContext } from "./types.js";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  lingzhuToOpenAI,
  formatLingzhuSSE,
  ToolCallAccumulator,
  parseToolCallFromAccumulated,
  detectIntentFromText,
  createFollowUpResponse,
  extractFollowUpFromText,
} from "./transform.js";
import { buildRequestLogName, summarizeForDebug, writeDebugLog } from "./debug-log.js";
import { createLingzhuToolSchemas } from "./lingzhu-tools.js";
import {
  cleanupImageCacheIfNeeded,
  ensureImageCacheDir,
} from "./image-cache.js";

interface LingzhuRuntimeState {
  config: LingzhuConfig;
  authAk: string;
  gatewayPort: number;
  chatCompletionsEnabled?: boolean;
}

const REMOTE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_IMAGE_TIMEOUT_MS = 15000;

function resolveMaxImageBytes(config: LingzhuConfig): number {
  if (typeof config.maxImageBytes === "number" && Number.isFinite(config.maxImageBytes)) {
    return Math.max(256 * 1024, Math.min(20 * 1024 * 1024, Math.trunc(config.maxImageBytes)));
  }

  return 5 * 1024 * 1024;
}

function normalizeContext(metadata: LingzhuRequest["metadata"]): LingzhuContext | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  if ("context" in metadata && metadata.context && typeof metadata.context === "object") {
    return metadata.context as LingzhuContext;
  }

  return metadata as LingzhuContext;
}

function extractFallbackUserText(messages: LingzhuRequest["message"]): string {
  return messages
    .map((message) => message.text || message.content || "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function buildSessionKey(config: LingzhuConfig, body: LingzhuRequest): string {
  const namespace = config.sessionNamespace || "lingzhu";
  const targetAgentId = config.agentId || body.agent_id || "main";
  const userId = body.user_id || body.agent_id || "anonymous";

  switch (config.sessionMode) {
    case "shared_agent":
      return `${namespace}:${targetAgentId}:shared`;
    case "per_message":
      return `${namespace}:${targetAgentId}:${body.message_id}`;
    case "per_user":
    default:
      return `${namespace}:${targetAgentId}:${userId}`;
  }
}

/**
 * 验证 Authorization 头
 */
function verifyAuth(
  authHeader: string | string[] | undefined,
  expectedAk: string
): boolean {
  if (!expectedAk) {
    // 未配置 AK 时跳过验证
    return true;
  }

  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header) return false;

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  return match[1].trim() === expectedAk;
}

/**
 * 读取 JSON 请求体
 */
async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error(`Request body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });

    req.on("error", (e) => reject(e));
  });
}

/**
 * 下载图片到本地临时目录，返回 file:// URL
 */
async function downloadImageToFile(imageUrl: string, maxBytes: number): Promise<string | null> {
  try {
    const parsedUrl = await validateRemoteImageUrl(imageUrl);
    if (!parsedUrl) {
      return null;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REMOTE_IMAGE_TIMEOUT_MS);
    const response = await fetch(parsedUrl, { redirect: "error", signal: controller.signal })
      .finally(() => clearTimeout(timeoutHandle));
    if (!response.ok) {
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") || "0");
    if (contentLength > maxBytes) {
      return null;
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      return null;
    }

    const ext = contentType.includes("png") ? ".png"
      : contentType.includes("jpeg") || contentType.includes("jpg") ? ".jpg"
        : contentType.includes("gif") ? ".gif"
          : contentType.includes("webp") ? ".webp"
            : ".img";

    const cacheDir = await ensureImageCacheDir();

    const hash = crypto.createHash("md5").update(imageUrl).digest("hex").slice(0, 12);
    const fileName = `img_${Date.now()}_${hash}${ext}`;
    const filePath = path.join(cacheDir, fileName);
    const reader = response.body?.getReader();
    if (!reader) {
      return null;
    }

    const fileStream = createWriteStream(filePath, { flags: "wx" });
    let totalBytes = 0;
    let completed = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel("image exceeds size limit");
          fileStream.destroy();
          await fs.unlink(filePath).catch(() => undefined);
          return null;
        }

        await new Promise<void>((resolve, reject) => {
          fileStream.write(Buffer.from(value), (error: Error | null | undefined) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end((error: Error | null | undefined) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      completed = true;
    } finally {
      if (!completed) {
        fileStream.destroy();
        await fs.unlink(filePath).catch(() => undefined);
      }
    }

    return `file://${filePath}`;
  } catch {
    return null;
  }
}

async function saveDataUrlToFile(dataUrl: string, maxBytes: number): Promise<string | null> {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  const mimeType = match[1].toLowerCase();
  const payload = match[2].replace(/\s+/g, "");
  if (estimateBase64DecodedBytes(payload) > maxBytes) {
    return null;
  }
  const buffer = Buffer.from(payload, "base64");
  if (buffer.length > maxBytes) {
    return null;
  }

  const ext = mimeType.includes("png")
    ? ".png"
    : mimeType.includes("jpeg") || mimeType.includes("jpg")
      ? ".jpg"
      : mimeType.includes("gif")
        ? ".gif"
        : mimeType.includes("webp")
          ? ".webp"
          : ".img";

  const cacheDir = await ensureImageCacheDir();
  const hash = crypto.createHash("md5").update(payload).digest("hex").slice(0, 12);
  const fileName = `img_${Date.now()}_${hash}${ext}`;
  const filePath = path.join(cacheDir, fileName);
  await fs.writeFile(filePath, buffer);
  return `file://${filePath}`;
}

function estimateBase64DecodedBytes(payload: string): number {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb");
}

function isPrivateAddress(address: string): boolean {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) {
    return isPrivateIpv4(address);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(address);
  }
  return false;
}

async function validateRemoteImageUrl(imageUrl: string): Promise<URL | null> {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return null;
  }

  if (!REMOTE_IMAGE_PROTOCOLS.has(parsedUrl.protocol)) {
    return null;
  }

  if (parsedUrl.username || parsedUrl.password) {
    return null;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateAddress(hostname)) {
    return null;
  }

  try {
    const resolved = await dns.lookup(parsedUrl.hostname, { all: true, verbatim: true });
    if (resolved.length === 0 || resolved.some((entry) => isPrivateAddress(entry.address))) {
      return null;
    }
  } catch {
    return null;
  }

  return parsedUrl;
}

function isPathWithinDirectory(filePath: string, parentDir: string): boolean {
  const relative = path.relative(parentDir, path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveTrustedFileUrl(fileUrl: string): Promise<string | null> {
  try {
    const cacheDir = await ensureImageCacheDir();
    const localPath = fileURLToPath(fileUrl);
    return isPathWithinDirectory(localPath, cacheDir) ? localPath : null;
  } catch {
    return null;
  }
}

/**
 * 预处理 OpenAI 消息：下载图片到本地并将路径嵌入到文本消息中
 * 注意：OpenClaw 的 /v1/chat/completions API 只提取文本内容，忽略 image_url
 * 因此我们将图片路径直接嵌入到文本中
 */
async function preprocessOpenAIMessages(
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: string; image_url?: { url: string }; text?: string }>;
  }>,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  maxImageBytes: number
): Promise<Array<{ role: "system" | "user" | "assistant"; content: string }>> {
  const result: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      result.push({ role: msg.role, content: String(msg.content) });
      continue;
    }

    // 处理多模态消息：收集文本和图片路径
    const textParts: string[] = [];
    const imagePaths: string[] = [];

    for (const part of msg.content) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.type === "image_url" && part.image_url?.url) {
        const url = part.image_url.url;

        if (url.startsWith("file://")) {
          const localPath = await resolveTrustedFileUrl(url);
          if (localPath) {
            imagePaths.push(localPath);
          } else {
            logger.warn("[Lingzhu] 已拒绝非缓存目录 file URL");
          }
        } else if (url.startsWith("data:")) {
          const fileUrl = await saveDataUrlToFile(url, maxImageBytes);
          if (fileUrl) {
            imagePaths.push(fileUrl.replace("file://", ""));
            logger.info("[Lingzhu] data URL 图片已保存到本地缓存");
          } else {
            logger.warn("[Lingzhu] data URL 图片处理失败或超出大小限制");
          }
        } else {
          // 下载图片到本地文件
          logger.info(`[Lingzhu] 正在下载图片到本地: ${url.substring(0, 80)}...`);
          const fileUrl = await downloadImageToFile(url, maxImageBytes);
          if (fileUrl) {
            imagePaths.push(fileUrl.replace("file://", ""));
            logger.info(`[Lingzhu] 图片已保存到: ${fileUrl}`);
          } else {
            logger.warn(`[Lingzhu] 图片下载失败或地址被拒绝: ${url}`);
          }
        }
      }
    }

    // 构建最终的文本消息
    let finalContent = textParts.join("\n");

    // 如果有图片，将图片路径嵌入到消息中
    if (imagePaths.length > 0) {
      const imageRefs = imagePaths.map((p) => `[图片: ${p}]`).join("\n");
      if (finalContent) {
        finalContent = `${finalContent}\n\n${imageRefs}`;
      } else {
        // 如果只有图片没有文字，添加占位文本
        finalContent = `用户发送了一张图片\n\n${imageRefs}`;
        logger.info("[Lingzhu] 为纯图片消息添加了占位文本");
      }
    }

    if (finalContent) {
      result.push({ role: msg.role, content: finalContent });
    }
  }

  return result;
}

/**
 * 创建 HTTP 处理器
 */
export function createHttpHandler(api: any, getRuntimeState: () => LingzhuRuntimeState) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/metis/agent/api/health" && req.method === "GET") {
      const state = getRuntimeState();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: true,
          endpoint: "/metis/agent/api/sse",
          enabled: state.config.enabled !== false,
          agentId: state.config.agentId || "main",
          supportedCommands: state.config.enableExperimentalNativeActions === true
            ? [
              "take_photo",
              "take_navigation",
              "control_calendar",
              "notify_agent_off",
              "send_notification",
              "send_toast",
              "speak_tts",
              "start_video_record",
              "stop_video_record",
              "open_custom_view",
            ]
            : ["take_photo", "take_navigation", "control_calendar", "notify_agent_off"],
          followUpEnabled: state.config.enableFollowUp !== false,
          sessionMode: state.config.sessionMode || "per_user",
          debugLogging: state.config.debugLogging === true,
          experimentalNativeActions: state.config.enableExperimentalNativeActions === true,
          chatCompletionsEnabled: state.chatCompletionsEnabled === true,
        })
      );
      return true;
    }

    if (url.pathname !== "/metis/agent/api/sse") {
      return false; // 不处理该路径，由后续处理器处理
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return true;
    }

    const logger = api.logger;
    const state = getRuntimeState();
    const config = state.config;

    if (config.enabled === false) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Lingzhu plugin is disabled" }));
      return true;
    }

    // 验证鉴权（使用生效中的 AK，支持自动生成场景）
    const authHeader = req.headers.authorization;
    if (!verifyAuth(authHeader, state.authAk || "")) {
      logger.warn("[Lingzhu] Unauthorized request");
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }

    let requestMessageId = "unknown";
    let requestAgentId = "unknown";

    try {
      // 解析请求体
      const body = (await readJsonBody(req)) as LingzhuRequest | undefined;
      if (!body || !body.message_id || !body.agent_id || !Array.isArray(body.message)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Missing required fields: message_id, agent_id, message",
          })
        );
        return true;
      }

      requestMessageId = body.message_id;
      requestAgentId = body.agent_id;
      const includePayload = config.debugLogPayloads === true;

      writeDebugLog(
        config,
        buildRequestLogName(body.message_id, "request.in"),
        {
          headers: req.headers,
          body: summarizeForDebug(body, includePayload),
        }
      );

      logger.info(
        `[Lingzhu] Request: message_id=${body.message_id}, agent_id=${body.agent_id}, messages=${body.message.length}`
      );

      // 设置 SSE 响应头
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      // 转换消息格式（根据配置决定是否包含设备信息）
      const includeMetadata = config.includeMetadata !== false; // 默认 true
      const maxImageBytes = resolveMaxImageBytes(config);
      await cleanupImageCacheIfNeeded();
      const context = includeMetadata ? normalizeContext(body.metadata) : undefined;
      let openaiMessages = lingzhuToOpenAI(
        body.message,
        context,
        {
          systemPrompt: config.systemPrompt,
          defaultNavigationMode: config.defaultNavigationMode,
          enableExperimentalNativeActions: config.enableExperimentalNativeActions,
        }
      );

      // 预处理消息：下载图片并为纯图片消息添加占位文本
      openaiMessages = await preprocessOpenAIMessages(openaiMessages as any, logger, maxImageBytes);
      const hasUserMsg = openaiMessages.some((message) => message.role === "user");
      if (!hasUserMsg) {
        const fallbackText = extractFallbackUserText(body.message) || "你好";
        openaiMessages.push({ role: "user", content: fallbackText });
        logger.warn(`[Lingzhu] No user message after transform, fallback=${fallbackText}`);
      }
      logger.info(
        `[Lingzhu] includeMetadata=${includeMetadata}, openaiMessages=${openaiMessages.length}, maxImageBytes=${maxImageBytes}`
      );

      // 生成 session key
      const sessionKey = buildSessionKey(config, body);
      const targetAgentId = config.agentId || body.agent_id || "main";

      // 获取 gateway 端口和 token
      const gatewayPort = api.config?.gateway?.port ?? state.gatewayPort ?? 18789;
      const gatewayToken = api.config?.gateway?.auth?.token;

      const lingzhuTools = createLingzhuToolSchemas(config.enableExperimentalNativeActions === true);

      // 调用 OpenClaw /v1/chat/completions API
      const openclawUrl = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
      const openclawBody = {
        model: `openclaw:${targetAgentId}`,
        stream: true,
        messages: openaiMessages,
        user: sessionKey,
        tools: lingzhuTools,
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-openclaw-agent-id": targetAgentId,
        "x-openclaw-session-key": sessionKey,
      };
      if (gatewayToken) {
        headers["Authorization"] = `Bearer ${gatewayToken}`;
      }

      writeDebugLog(
        config,
        buildRequestLogName(body.message_id, "openclaw.request"),
        {
          url: openclawUrl,
          headers: summarizeForDebug(headers, includePayload),
          body: summarizeForDebug(openclawBody, includePayload),
        }
      );

      const timeoutMs = typeof config.requestTimeoutMs === "number"
        ? Math.max(5000, Math.min(300000, Math.trunc(config.requestTimeoutMs)))
        : 60000;

      logger.info(
        `[Lingzhu] Calling OpenClaw: ${openclawUrl}, agentId=${targetAgentId}, sessionKey=${sessionKey}, timeout=${timeoutMs}ms`
      );

      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);

      let openclawResponse: Response;
      try {
        openclawResponse = await fetch(openclawUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(openclawBody),
          signal: timeoutController.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`OpenClaw request timeout after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!openclawResponse.ok) {
        const errorText = await openclawResponse.text();
        throw new Error(`OpenClaw API error: ${openclawResponse.status} - ${errorText}`);
      }

      // 收集完整响应用于提取 follow_up
      let fullResponse = "";

      // 工具调用累积器 - 处理流式 tool_calls 参数分片
      const toolAccumulator = new ToolCallAccumulator();

      // 流式解析 OpenAI SSE
      const reader = openclawResponse.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      // 保活机制：每 7 秒发送 SSE 注释，防止灵珠超时断开
      const keepaliveInterval = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {
          // 连接已关闭，忽略
          clearInterval(keepaliveInterval);
        }
      }, 7000);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;

            const data = trimmed.slice(6);
            if (data === "[DONE]") {
              continue;
            }

            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta;
              const finishReason = chunk.choices?.[0]?.finish_reason;

              // 累积工具调用片段（不立即发送，等完整后再发送）
              if (delta?.tool_calls) {
                toolAccumulator.accumulate(delta.tool_calls);
              }

              writeDebugLog(
                config,
                buildRequestLogName(body.message_id, "openclaw.chunk"),
                summarizeForDebug(chunk, includePayload)
              );

              // 兼容模式：仅累积文本，结束后一次性返回给灵珠。
              // 灵珠端对分片 answer + done 的容错较差，先收敛到最保守协议。
              if (delta?.content) {
                fullResponse += delta.content;
              }

              // 当流结束且有工具调用时，发送完整的工具调用
              if (finishReason === "tool_calls" || (finishReason && toolAccumulator.hasTools())) {
                const completedTools = toolAccumulator.getCompleted();

                for (const tool of completedTools) {
                  const lingzhuToolCall = parseToolCallFromAccumulated(tool.name, tool.arguments, {
                    defaultNavigationMode: config.defaultNavigationMode,
                    enableExperimentalNativeActions: config.enableExperimentalNativeActions,
                  });

                  if (lingzhuToolCall) {
                    const toolData = {
                      role: "agent" as const,
                      type: "tool_call" as const,
                      message_id: body.message_id,
                      agent_id: body.agent_id,
                      is_finish: true,
                      tool_call: lingzhuToolCall,
                    };
                    writeDebugLog(
                      config,
                      buildRequestLogName(body.message_id, "response.tool_call"),
                      summarizeForDebug(toolData, includePayload)
                    );
                    res.write(formatLingzhuSSE("message", toolData));
                  }
                }
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      } finally {
        clearInterval(keepaliveInterval);
      }

      const hasToolCall = toolAccumulator.hasTools();

      // 仅当模型返回了显式工具标记时，才从完整文本中回退解析 tool_call。
      // 普通自然语言回答后再补发 tool_call，灵珠端容易判定为异常结束包。
      if (!hasToolCall && fullResponse && fullResponse.includes("<LINGZHU_TOOL_CALL:")) {
        const detectedIntent = detectIntentFromText(fullResponse, {
          defaultNavigationMode: config.defaultNavigationMode,
          enableExperimentalNativeActions: config.enableExperimentalNativeActions,
        });
        if (detectedIntent) {
          logger.info(`[Lingzhu] 从文本检测到意图: ${JSON.stringify(detectedIntent)}`);
          const toolData = {
            role: "agent" as const,
            type: "tool_call" as const,
            message_id: body.message_id,
            agent_id: body.agent_id,
            is_finish: true,
            tool_call: detectedIntent,
          };
          const sseOutput = formatLingzhuSSE("message", toolData);
          logger.info(`[Lingzhu] 发送给灵珠的 SSE: ${sseOutput.replace(/\n/g, "\\n")}`);
          writeDebugLog(
            config,
            buildRequestLogName(body.message_id, "response.intent_fallback"),
            summarizeForDebug(toolData, includePayload)
          );
          res.write(sseOutput);
        }
      } else if (!hasToolCall && fullResponse) {
        const finalAnswerData = {
          role: "agent" as const,
          type: "answer" as const,
          answer_stream: fullResponse,
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: true,
        };
        writeDebugLog(
          config,
          buildRequestLogName(body.message_id, "response.final_answer"),
          summarizeForDebug(finalAnswerData, includePayload)
        );
        res.write(formatLingzhuSSE("message", finalAnswerData));

        if (config.enableFollowUp !== false) {
          const followUps = extractFollowUpFromText(
            fullResponse,
            typeof config.followUpMaxCount === "number" ? config.followUpMaxCount : 3
          );

          if (followUps && followUps.length > 0) {
            const followUpData = createFollowUpResponse(followUps, body.message_id, body.agent_id);
            writeDebugLog(
              config,
              buildRequestLogName(body.message_id, "response.follow_up"),
              summarizeForDebug(followUpData, includePayload)
            );
            res.write(formatLingzhuSSE("message", followUpData));
          }
        }
      }

      writeDebugLog(
        config,
        buildRequestLogName(body.message_id, "response.done"),
        {
          hasToolCall,
          fullResponse: summarizeForDebug(fullResponse, includePayload),
        }
      );
      res.end();
      logger.info(`[Lingzhu] Completed: message_id=${body.message_id}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[Lingzhu] Error: ${errorMsg}`);
      writeDebugLog(
        config,
        buildRequestLogName(requestMessageId, "error"),
        {
          message_id: requestMessageId,
          agent_id: requestAgentId,
          error: errorMsg,
        },
        true
      );

      // 发送错误响应
      const errorData = {
        role: "agent" as const,
        type: "answer" as const,
        answer_stream: `[错误] ${errorMsg}`,
        message_id: requestMessageId,
        agent_id: requestAgentId,
        is_finish: true,
      };
      res.write(formatLingzhuSSE("message", errorData));
      res.end();
    }

    return true;
  };
}
