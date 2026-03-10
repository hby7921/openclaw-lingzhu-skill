import type { Command } from "commander";
import type { LingzhuConfig } from "./types.js";
import { getDebugLogFilePath } from "./debug-log.js";

interface CliContext {
  program: Command;
}

interface LingzhuState {
  config: LingzhuConfig;
  authAk: string;
  gatewayPort: number;
}

/**
 * 注册 CLI 命令
 */
export function registerLingzhuCli(
  ctx: CliContext,
  getState: () => LingzhuState
) {
  const { program } = ctx;

  const lingzhuCmd = program
    .command("lingzhu")
    .description("灵珠平台接入管理");

  lingzhuCmd
    .command("info")
    .description("显示灵珠接入信息")
    .action(() => {
      const state = getState();
      const url = `http://127.0.0.1:${state.gatewayPort}/metis/agent/api/sse`;
      const debugLogState = `${state.config.debugLogging ? "ON " : "OFF"} ${getDebugLogFilePath(state.config)}`;

      console.log("");
      console.log("╔═══════════════════════════════════════════════════════════╗");
      console.log("║           灵珠平台接入信息                                 ║");
      console.log("╠═══════════════════════════════════════════════════════════╣");
      console.log(`║  SSE 接口:   ${url.padEnd(45)}║`);
      console.log(`║  鉴权 AK:    ${state.authAk.padEnd(45)}║`);
      console.log(`║  智能体 ID:  ${(state.config.agentId || "main").padEnd(45)}║`);
      console.log(`║  会话策略:   ${(state.config.sessionMode || "per_user").padEnd(45)}║`);
      console.log(`║  调试日志:   ${debugLogState.padEnd(45)}║`);
      console.log(`║  状态:       ${(state.config.enabled !== false ? "已启用 ✓" : "已禁用 ✗").padEnd(45)}║`);
      console.log("╚═══════════════════════════════════════════════════════════╝");
      console.log("");
      console.log("提交给灵珠平台:");
      console.log(`  • 智能体SSE接口地址: ${url}`);
      console.log(`  • 智能体鉴权AK: ${state.authAk}`);
      console.log("");
    });

  lingzhuCmd
    .command("status")
    .description("检查灵珠接入状态")
    .action(() => {
      const state = getState();
      if (state.config.enabled !== false) {
        console.log("✓ 灵珠接入已启用");
      } else {
        console.log("✗ 灵珠接入已禁用");
      }
    });

  lingzhuCmd
    .command("curl")
    .description("输出可直接复制的本地联调 curl 命令")
    .action(() => {
      const state = getState();
      const url = `http://127.0.0.1:${state.gatewayPort}/metis/agent/api/sse`;
      const agentId = state.config.agentId || "main";

      console.log("curl -X POST '" + url + "' \\");
      console.log("--header 'Authorization: Bearer " + state.authAk + "' \\");
      console.log("--header 'Content-Type: application/json' \\");
      console.log("--data '{");
      console.log("  \"message_id\": \"test_local_01\",");
      console.log("  \"agent_id\": \"" + agentId + "\",");
      console.log("  \"message\": [");
      console.log("    {\"role\": \"user\", \"type\": \"text\", \"text\": \"你好\"}");
      console.log("  ]");
      console.log("}'");
    });

  lingzhuCmd
    .command("capabilities")
    .description("显示当前桥接支持的眼镜能力")
    .action(() => {
      console.log("支持的眼镜能力:");
      console.log("  - take_photo: 拍照");
      console.log("  - take_navigation: 导航");
      console.log("  - control_calendar: 日程提醒");
      console.log("  - notify_agent_off: 退出智能体");
      console.log("  - send_notification: 实验性通知");
      console.log("  - send_toast: 实验性提示");
      console.log("  - speak_tts: 实验性播报");
      console.log("  - start_video_record / stop_video_record: 实验性录像");
      console.log("  - open_custom_view: 实验性自定义页面");
      console.log("");
      console.log("桥接增强能力:");
      console.log("  - 多模态图片预处理（file URL / data URL / 远程图片）");
      console.log("  - Follow-up 建议生成");
      console.log("  - 可配置会话策略");
      console.log("  - 健康检查与联调 curl");
      console.log("  - 文件调试日志与载荷脱敏");
    });

  lingzhuCmd
    .command("logpath")
    .description("显示桥接文件日志路径")
    .action(() => {
      const state = getState();
      console.log(getDebugLogFilePath(state.config));
    });

  return lingzhuCmd;
}
