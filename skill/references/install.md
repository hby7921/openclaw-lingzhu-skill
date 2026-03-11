---
name: lingzhu
description: 灵珠平台接入 - 将 OpenClaw 接入灵珠智能体平台
metadata: {"openclaw":{"emoji":"🔗","requires":{"plugins":["lingzhu"],"config":["gateway.http.endpoints.chatCompletions.enabled"]}}}
---

# 灵珠平台接入

灵珠平台是一个第三方智能体平台。通过 `lingzhu` 插件，可以把 OpenClaw 接入灵珠平台，并在 Rokid/乐奇眼镜场景下完成联调。

## 安装步骤

### 1. 安装 `lingzhu` 插件

```bash
openclaw plugins install --link {baseDir}/extension
```

如果你是云服务器部署，仓库根目录也提供了现成模板：

```bash
bash deploy/ubuntu-quick-install.sh
```

相关文件：

- `deploy/ubuntu-quick-install.sh`
- `deploy/openclaw.lingzhu.config.json5`
- `deploy/openclaw-gateway.service.example`

### 2. 启用 Chat Completions API

在 `openclaw.json` 或 `moltbot.json` 中添加：

```json5
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

### 3. 配置插件

```json5
{
  "plugins": {
    "entries": {
      "lingzhu": {
        "enabled": true,
        "config": {
          "authAk": "",
          "agentId": "main",
          "includeMetadata": true,
          "requestTimeoutMs": 60000,
          "sessionMode": "per_user",
          "sessionNamespace": "lingzhu",
          "defaultNavigationMode": "0",
          "enableFollowUp": true,
          "followUpMaxCount": 3,
          "maxImageBytes": 5242880,
          "debugLogging": true,
          "debugLogPayloads": false,
          "debugLogDir": "",
          "enableExperimentalNativeActions": true
        }
      }
    }
  }
}
```

### 4. 重启 Gateway

```bash
openclaw gateway restart
```

## 查看状态

```bash
openclaw lingzhu info
openclaw lingzhu status
openclaw lingzhu curl
openclaw lingzhu capabilities
openclaw lingzhu logpath
openclaw lingzhu doctor
openclaw lingzhu cache-cleanup
```

## 健康检查

```bash
curl http://127.0.0.1:18789/metis/agent/api/health
```

## 提交给灵珠平台

1. 智能体 SSE 接口地址：`http://<公网 IP>:18789/metis/agent/api/sse`
2. 智能体鉴权 AK：运行 `openclaw lingzhu curl`，从输出中的 `Authorization: Bearer ...` 提取完整 AK

## 推荐测试项

1. 文字问答：确认眼镜端能正常显示文字回答。
2. 拍照：说“帮我拍张照”，确认出现 `take_photo`。
3. 导航：说“导航去公司”，确认出现 `take_navigation`，并检查 `poi_name/navi_type`。
4. 日程：说“明天上午十点提醒我开会”，确认出现 `control_calendar`。
5. 退出：说“退出智能体”，确认出现 `notify_agent_off`。
6. 图片输入：测试图片问题是否能进入 OpenClaw。
7. 多轮对话：连续问两轮，确认 `sessionMode=per_user` 时上下文持续存在。
8. 通知：说“给我发个通知，内容是准备出门”，确认是否出现 `send_notification`。
9. TTS：说“播报一句测试成功”，确认是否出现 `speak_tts`。
10. 录像：说“开始录像”再说“停止录像”，确认是否出现 `start_video_record/stop_video_record`。
