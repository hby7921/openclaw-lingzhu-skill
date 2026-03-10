# OpenClaw Mowan

面向 Rokid 眼镜的 Lingzhu ↔ OpenClaw 专用桥接插件。

## 安装

```bash
# 从本地目录安装
openclaw plugins install ./extension

# 或链接开发模式
openclaw plugins install -l ./extension
```

## 配置

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
  },
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
          "systemPrompt": "你是部署在 Rokid 眼镜上的智能体助手。",
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

## CLI

```bash
openclaw lingzhu info
openclaw lingzhu status
openclaw lingzhu curl
openclaw lingzhu capabilities
openclaw lingzhu logpath
```

## 健康检查

```bash
curl http://127.0.0.1:18789/metis/agent/api/health
```

## 调试日志

开启 `debugLogging` 后，桥接日志默认写入插件目录下的 `logs/`：

- `logs/lingzhu-YYYY-MM-DD.log`

建议联调时先这样配置：

- `debugLogging: true`
- `debugLogPayloads: false`

只有需要精确排查协议载荷时，再临时改成：

- `debugLogPayloads: true`

## 实验性原生动作

开启 `enableExperimentalNativeActions` 后，会额外向模型暴露这些实验动作：

- `send_notification`
- `send_toast`
- `speak_tts`
- `start_video_record`
- `stop_video_record`
- `open_custom_view`

这些动作是否被灵珠平台或眼镜端真正识别，仍需要真机日志验证。
