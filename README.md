# Vertex PayGo 个人中转适配版

基于 [Mana Nekoha 的 ST-Vertex-PayGo](https://github.com/mananekoha114/ST-Vertex-PayGo)，上游基线 52ebf2574ddffc05d00edbc6797e85855e23914f，保留 MPL-2.0 许可证。个人改动用于 TauriTavern 的自定义 OpenAI 中转费用统计，原作者不负责此适配版。

## 手机安装

1. 先禁用或卸载原版 Vertex PayGo 扩展，避免两个版本同时拦截请求。
2. 在 TauriTavern 的“扩展 → 安装扩展”粘贴：
   https://github.com/18084213166/ST-Vertex-PayGo-Personal
3. 重启 TauriTavern。连接方式仍选自定义 OpenAI，API 地址及 API Key 保持现有中转配置。
4. 普通模型和“抗截断-”模型均可。回复头像下方会出现费用；点击查看输入、缓存、输出和思考 Token。魔法棒菜单可打开当前对话账本。

需要原版要求的 TauriTavern 扩展存储及附加参数 API（上游测试基线 2.3.0）。手机无需 Node.js，也不需要将 Vertex JSON 上传到插件。

## 计费依据

- 只对指定个人中转域名和本机 8788 的 /v1 自定义连接启用适配；其他连接继续使用原版逻辑。
- 价格快照与实际 Standard/Flex 档位来自每次中转响应，支持后台多凭证分别设置档位。
- 普通流式和工具封装流式均保留原始响应字节；不增加模型请求，不重复调用。
- 缓存输入、普通输入、候选输出、思考 Token 分开计算。抗截断别名使用基础模型的价格。
- 中转后台未定价、响应未提供准确用量或实际档位、客户端丢失相关字段时，显示未知/未定价，绝不假定免费或套用 Standard。
- 金额是美元估算，不代表 Google 实际账单、赠金余额或余额扣除。图片/音视频等不支持的计费模态不估算。
- 旧消息不会被追溯补账。后台切换计费、价格或密钥后，新请求自动使用新的响应快照。
- 中转请求中携带额外工具/多模态而走 Google OpenAI 原生兼容转发时可能没有报价，不保证费用统计。

适配域名：personal-vertex-relay.personal-vertex-relay.workers.dev；若以后更换域名，需要同步修改 src/personal-relay.js。
插件不存储聊天原文和密钥，只在手机本地保存用量与费用记录。使用中转后台原有日志功能时，聊天日志仍由后台设置控制。

## 开发验证

npm ci --ignore-scripts
npm test

新增测试覆盖普通/抗截断分片 SSE、消息费用关联、思考与缓存计费、档位/模型不匹配时拒绝猜价及钩子卸载。真实手机安装后的界面仍需在手机上验证。
