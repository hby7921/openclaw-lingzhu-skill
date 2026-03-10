---
name: lingzhu
description: 灵珠平台接入 - 将 Moltbot 接入灵珠智能体平台
metadata: {"openclaw":{"emoji":"🔗","requires":{"plugins":["lingzhu"],"config":["gateway.http.endpoints.chatCompletions.enabled"]}}}
---

# 灵珠平台接入

灵珠平台是一个第三方智能体平台，通过 lingzhu 插件可以将 Moltbot/OpenClaw 接入灵珠平台。

## 安装步骤

### 1. 安装 lingzhu 插件

```bash
# 从技能目录安装（使用 --link 进行开发模式链接）
openclaw plugins install --link {baseDir}/extension
```

如果你是云服务器部署，仓库根目录已经附带现成模板：

```bash
# 一键拉取/更新 + npm install + 链接插件
bash deploy/ubuntu-quick-install.sh
```

相关文件：
- `deploy/ubuntu-quick-install.sh`
- `deploy/openclaw.mowan.config.json5`
- `deploy/openclaw-gateway.service.example`

### 2. 启用 Chat Completions API

在 `moltbot.json` 中添加：

```json5
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true // 必须启用
        }
      }
    }
  }
}
```

### 3. 配置插件（推荐）

```json5
{
  "plugins": {
    "entries": {
      "lingzhu": {
        "enabled": true,
        "config": {
          "authAk": "",                // 留空自动生成并持久化
          "agentId": "main",           // OpenClaw 智能体 ID
          "includeMetadata": true,       // 是否透传设备信息（时间/位置/电量）
          "requestTimeoutMs": 60000,     // 上游请求超时，范围 5000~300000
          "sessionMode": "per_user",     // per_user / shared_agent / per_message
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

### 查看连接信息

```bash
openclaw lingzhu info
```

### 查看状态

```bash
openclaw lingzhu status
```

### 输出测试请求命令

```bash
openclaw lingzhu curl
```

### 查看桥接能力

```bash
openclaw lingzhu capabilities
```

### 查看日志路径

```bash
openclaw lingzhu logpath
```

## 健康检查

```bash
curl http://127.0.0.1:18789/metis/agent/api/health
```

预期返回：

```json
{"ok":true,"endpoint":"/metis/agent/api/sse","enabled":true,"agentId":"main","sessionMode":"per_user","debugLogging":true}
```

## 提交给灵珠平台

1. **智能体 SSE 接口地址**: `http://<公网IP>:18789/metis/agent/api/sse`
2. **智能体鉴权 AK**: CLI 显示的 AK 值

## 服务器侧最小清单

1. `git`
2. `npm`
3. `openclaw` 命令可直接执行
4. 网关端口已对外开放，默认 `18789/tcp`
5. OpenClaw 主配置中已合并 `deploy/openclaw.mowan.config.json5`

## 推荐测试项

1. 文字问答：确认眼镜能正常流式出字和播报。
2. 拍照：说“帮我拍张照”，确认出现 `take_photo`。
3. 导航：说“导航去公司”，确认出现 `take_navigation`，并检查 `poi_name/navi_type`。
4. 日程：说“明天上午十点提醒我开会”，确认出现 `control_calendar`。
5. 退出：说“退出智能体”，确认出现 `notify_agent_off`。
6. 图片输入：如果灵珠平台开启图片入参，测试图片提问是否进入 OpenClaw。
7. 多轮对话：连续问两轮，确认 `sessionMode=per_user` 时上下文持续存在。
8. 通知：说“给我发个通知，内容是准备出门”，确认是否出现 `send_notification`。
9. TTS：说“播报一句测试成功”，确认是否出现 `speak_tts`。
10. 录像：说“开始录像”再说“停止录像”，确认是否出现 `start_video_record/stop_video_record`。
