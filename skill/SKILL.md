---
name: lingzhu
description: 通过灵珠平台将 OpenClaw 接入 Rokid/乐奇眼镜，支持拍照、导航、日程和实验性原生动作桥接。
metadata: {"openclaw":{"emoji":"🔗","requires":{"plugins":["lingzhu"],"config":["gateway.http.endpoints.chatCompletions.enabled"]},"install":[{"kind":"node","package":"@r.wmi/openclaw-lingzhu"}]}}
---

## 支持的设备命令

| 灵珠命令 | OpenClaw 工具名 | 说明 |
| :--- | :--- | :--- |
| `take_photo` | `take_photo`, `camera`, `photo` | 拍照 |
| `take_navigation` | `navigate`, `navigation`, `maps` | 导航 |
| `control_calendar` | `calendar`, `schedule`, `reminder` | 日程提醒 |
| `notify_agent_off` | `exit`, `quit` | 退出智能体 |
| `send_notification` | `send_notification`, `notify` | 实验性通知 |
| `send_toast` | `send_toast`, `toast` | 实验性提示 |
| `speak_tts` | `speak_tts`, `tts` | 实验性播报 |
| `start_video_record` | `start_video_record`, `record_video` | 实验性录像 |
| `open_custom_view` | `open_custom_view`, `show_view` | 实验性自定义页面 |

## 接入说明

请阅读 `references/install.md` 按步骤完成安装、配置和联调。
