/**
 * 灵珠设备工具定义
 * 这些工具会被注册到 OpenClaw Agent，当 AI 调用时会转换为灵珠设备命令
 */

// 拍照工具参数
const TakePhotoParams = {
    type: "object",
    properties: {},
    required: []
};

// 导航工具参数
const NavigateParams = {
    type: "object",
    properties: {
        destination: { type: "string", description: "目标地址或 POI 名称" },
        navi_type: {
            type: "string",
            enum: ["0", "1", "2"],
            description: "导航类型：0=驾车，1=步行，2=骑行"
        },
    },
    required: ["destination"],
};

// 日程工具参数
const CalendarParams = {
    type: "object",
    properties: {
        title: { type: "string", description: "日程标题" },
        start_time: { type: "string", description: "开始时间，格式：YYYY-MM-DD HH:mm" },
        end_time: { type: "string", description: "结束时间，格式：YYYY-MM-DD HH:mm" },
    },
    required: ["title", "start_time"],
};

const NotificationParams = {
    type: "object",
    properties: {
        content: { type: "string", description: "通知内容" },
        play_tts: { type: "boolean", description: "是否同步播报 TTS" },
        icon_type: { type: "string", description: "图标类型，默认 1" },
    },
    required: ["content"],
};

const ToastParams = {
    type: "object",
    properties: {
        content: { type: "string", description: "Toast 内容" },
        play_tts: { type: "boolean", description: "是否同步播报 TTS" },
        icon_type: { type: "string", description: "图标类型，默认 1" },
    },
    required: ["content"],
};

const TtsParams = {
    type: "object",
    properties: {
        content: { type: "string", description: "播报内容" },
    },
    required: ["content"],
};

const VideoRecordParams = {
    type: "object",
    properties: {
        duration_sec: { type: "number", description: "录像时长，单位秒" },
        width: { type: "number", description: "录像宽度" },
        height: { type: "number", description: "录像高度" },
        quality: { type: "number", description: "画质/质量，实验字段" },
    },
    required: []
};

const CustomViewParams = {
    type: "object",
    properties: {
        view_name: { type: "string", description: "页面名称" },
        view_payload: { type: "string", description: "页面 JSON 或配置字符串" },
    },
    required: ["view_name"]
};

/**
 * 创建灵珠设备工具
 * 这些工具由灵珠设备端执行，OpenClaw 仅负责转换协议
 */
export function createLingzhuTools(enableExperimentalNativeActions = false) {
    const tools: any[] = [
        {
            name: "take_photo",
            description: "使用灵珠设备的摄像头拍照。当用户要求拍照、拍摄、照相时，调用此工具。",
            parameters: TakePhotoParams,
            async execute(_id: string, _params: any) {
                // 返回特殊标记，让 http-handler 识别并生成 tool_call
                return {
                    content: [
                        {
                            type: "text",
                            text: `<LINGZHU_TOOL_CALL:take_photo:{}> 正在通过灵珠设备拍照...`,
                        },
                    ],
                };
            },
        },
        {
            name: "navigate",
            description: "使用灵珠设备的导航功能，导航到指定地址或POI。",
            parameters: NavigateParams,
            async execute(_id: string, params: any) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `<LINGZHU_TOOL_CALL:take_navigation:${JSON.stringify(params)}> 正在导航到 ${params.destination}...`,
                        },
                    ],
                };
            },
        },
        {
            name: "calendar",
            description: "在灵珠设备上创建日程提醒。",
            parameters: CalendarParams,
            async execute(_id: string, params: any) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `<LINGZHU_TOOL_CALL:control_calendar:${JSON.stringify(params)}> 已创建日程: ${params.title}`,
                        },
                    ],
                };
            },
        },
        {
            name: "exit_agent",
            description: "退出当前智能体会话，返回灵珠主界面。",
            parameters: { type: "object", properties: {} },
            async execute() {
                return {
                    content: [
                        {
                            type: "text",
                            text: `<LINGZHU_TOOL_CALL:notify_agent_off:{}> 正在退出智能体...`,
                        },
                    ],
                };
            },
        },
    ];

    if (enableExperimentalNativeActions) {
        tools.push(
            {
                name: "send_notification",
                description: "向眼镜发送通知，可选同步 TTS 播报。实验性原生动作。",
                parameters: NotificationParams,
                async execute(_id: string, params: any) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `<LINGZHU_TOOL_CALL:send_notification:${JSON.stringify(params)}> 已向眼镜发送通知`,
                            },
                        ],
                    };
                },
            },
            {
                name: "send_toast",
                description: "向眼镜发送短提示 Toast。实验性原生动作。",
                parameters: ToastParams,
                async execute(_id: string, params: any) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `<LINGZHU_TOOL_CALL:send_toast:${JSON.stringify(params)}> 已向眼镜发送提示`,
                            },
                        ],
                    };
                },
            },
            {
                name: "speak_tts",
                description: "在眼镜端直接播报一段文本。实验性原生动作。",
                parameters: TtsParams,
                async execute(_id: string, params: any) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `<LINGZHU_TOOL_CALL:speak_tts:${JSON.stringify(params)}> 正在播报文本`,
                            },
                        ],
                    };
                },
            },
            {
                name: "start_video_record",
                description: "开始眼镜录像。实验性原生动作。",
                parameters: VideoRecordParams,
                async execute(_id: string, params: any) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `<LINGZHU_TOOL_CALL:start_video_record:${JSON.stringify(params)}> 正在开始录像`,
                            },
                        ],
                    };
                },
            },
            {
                name: "stop_video_record",
                description: "停止眼镜录像。实验性原生动作。",
                parameters: { type: "object", properties: {}, required: [] },
                async execute() {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `<LINGZHU_TOOL_CALL:stop_video_record:{}> 正在停止录像`,
                            },
                        ],
                    };
                },
            },
            {
                name: "open_custom_view",
                description: "打开眼镜上的实验性自定义页面。实验性原生动作。",
                parameters: CustomViewParams,
                async execute(_id: string, params: any) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `<LINGZHU_TOOL_CALL:open_custom_view:${JSON.stringify(params)}> 正在打开自定义页面`,
                            },
                        ],
                    };
                },
            }
        );
    }

    return tools;
}
