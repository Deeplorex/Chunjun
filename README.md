# 纯钧 Chunjun

神兵系列 · 本地桌面图片处理工具。

当前已完成产品定义、Figma 高保真、品牌资产，并初始化 Tauri 2 + Rust + React 桌面工程。

当前已接入本地导入、压缩、转换、裁剪、明水印、受限元数据直写与副本导出。OCR、完整来源/色彩字段迁移、平台原始样本和离线安装验收仍未完成；含已知来源或色彩字段的重编码会明确拒绝，避免静默丢信息。下列设计是完整目标范围，逐项状态见[审查与待办登记](docs/reviews/2026-11-04.md)。

开发环境：Windows 11、Node 24.18.0、pnpm 9.15.0、Rust 1.98.0、MSVC 构建工具和 WebView2。执行 `pnpm install --frozen-lockfile` 后用 `pnpm dev` 打开桌面窗口；`pnpm dev:web` 仅供查看界面。

- [产品与实现状态](docs/product/README.md)
- [架构与边界](docs/architecture/README.md)
- [开发、检查与打包](docs/engineering/README.md)
- [工程规则](AGENTS.md) · [工程决策](.project/standard-project.json) · [变化记录](docs/changes.md)

本机开发交接提示词位于 `.handoff/开发交接提示词.md`，该目录已加入 Git 忽略，不随仓库分发。

- [Figma 高保真设计](https://www.figma.com/design/A1vGeie8es1ZWYTU8dJnIQ?node-id=11-105)
- [Figma 主要流程演示](https://www.figma.com/proto/A1vGeie8es1ZWYTU8dJnIQ?node-id=11-28&starting-point-node-id=11%3A28)
- [完整功能清单](design/纯钧-完整功能清单.html)：58 项功能、格式矩阵、AIGC 能力边界与验收条件。
- [本地设计预览](design/index.html)：16 个关键界面。

Figma 分为「产品与功能」「桌面高保真」「组件与规范」「品牌与图标资产」四个页面。
设计采用暖白与石墨色、青绿色主操作、中文排版和细线图标。

图片压缩、格式转换、裁剪尺寸与 水印与声明四个工作区共用文件列表和导出流程。
设计要求全程本地处理、离线可用、默认导出副本。具体能力与范围以功能清单为准。

水印与声明包含两个并列入口：明水印（用途、版权、品牌与 AIGC 提示）和元数据声明（通用来源与结构化 AIGC 声明）。用途水印提供证件复印件模板、斜向平铺、透明度与可选日期；元数据读写无需 AI 模型。

元数据默认自动识别平台元数据并沿用已有声明，原始字段收在高级选项中。首版适配目标包括即梦／豆包、通义万相、混元、文心生图、可灵／可图、ChatGPT、Gemini、Firefly 和 Midjourney；逐平台、下载入口与格式使用原始样本验收，当前为设计范围，尚未实现兼容引擎。

品牌已更新为「叠帧·方寸」，以取景折角与中央像素区别于湛卢的剑形。

- [Logo 与图标资产预览](assets/brand/index.html)
- [完整资产包 ZIP](Chunjun-Brand-Assets-v1.zip)
- [Figma 品牌规范](https://www.figma.com/design/A1vGeie8es1ZWYTU8dJnIQ?node-id=37-260)

资产包含标准、单色、反白与小尺寸主标，横竖转曲组合标，16–1024px PNG、Windows ICO、macOS ICNS，48 枚功能图标与 8 类图片文件图标。
