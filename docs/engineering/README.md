# 工程开发与检查

当前已含图片处理核心代码与受限元数据直写；验收和未完成项见 `docs/reviews/2026-11-04.md`。环境为 Windows 11、MSVC C++ 构建工具及 Windows SDK、WebView2、Rust 1.98.0（rustfmt/clippy）、Node 24.18.0、pnpm 9.15.0。版本由 `rust-toolchain.toml`、`.node-version`、package 与锁文件固定。运行不需要 API Key 或账号。

首次执行 `pnpm install --frozen-lockfile` 后，`pnpm dev` 打开原生桌面框架。安装自动设置本仓库 `.githooks`，不改变全局 Git。`pnpm dev:web` 只预览框架，明确显示浏览器状态，不模拟桌面连接成功。

| 命令                                                                 | 用途                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm dev` / `pnpm dev:web`                                          | 桌面开发 / 浏览器框架预览                                   |
| `pnpm exec vitest run src/App.test.tsx src/platform/desktop.test.ts` | 工作区、导出、预览、设置反馈与任务订阅回归                  |
| `node --test scripts/check-changes.test.mjs`                         | 变化记录与测试引用规则                                      |
| `pnpm native:test`                                                   | 授权、图像处理、元数据、导出和窗口适配测试                  |
| `pnpm format` / `pnpm format:check`                                  | 工程 Prettier 与 Rust 格式；不重写已有设计/品牌资料         |
| `pnpm lint` / `pnpm typecheck`                                       | Lint 与类型检查                                             |
| `pnpm change:check`                                                  | 新变化记录与测试链接；默认与 HEAD 比较，CI 可传 CHANGE_BASE |
| `pnpm quality`                                                       | 初始化稳定后的格式、Lint、类型、测试、原生检查与构建基线    |
| `pnpm desktop:build`                                                 | 构建未签名桌面可执行文件，不制作安装包                      |
| `pnpm quality:full`                                                  | 基线加生产依赖和 Rust 审计；需 cargo-audit                  |
| `pnpm release:preflight`                                             | 发布前检查与 Tauri 环境诊断                                 |
| `pnpm desktop:package`                                               | NSIS 打包，内嵌 WebView2 引导器（缺失时联网下载运行时）     |

## 例行开发

先读根 `AGENTS.md`、产品契约和技术架构，再按用户明确要求实现单个功能。功能需求、优化、Bug 与行为维护在 `docs/changes.md` 留一条简短记录，引用直接测试；非 Bug 可解释 `existing coverage:`。Bug 需要新增或更新回归测试。文档修改无需新行为测试。

pre-commit 只检查暂存内容的格式与 Lint，commit-msg 要求 Conventional Commits，例如 `feat(import): 添加图片导入`。钩子不修改暂存区、不运行全套检查。`change:check` 证明记录/测试引用存在，不代替测试执行和最终差异审查。Routine 只跑受影响检查；初始化稳定后跑一次基线。未授权不要暂存、提交、推送、签名或发布。

CI 的 PR/主分支工作流使用冻结依赖和 Windows 原生测试入口；手动桌面预览工作流执行质量基线并上传未签名框架可执行文件。工作流文件存在不表示远程 CI 已运行。

## 打包和后续发布

可执行文件位于 `src-tauri/target/release`；NSIS 产物在 `bundle/nsis`。当前为部分功能实现，尚未完成产品验收。NSIS 配置为 current-user 加 WebView2 `embedBootstrapper`：目标机器没有 WebView2 时需要联网下载运行时。完全离线的安装方案仍待定；正式离线发行需实际测试，不能只根据配置声称通过。

后续发布需核心功能/基础 OCR 与规则实际随包、源文件保护、错误/取消/重试、最小窗口和键盘路径、干净 Windows 11 断网安装/首次运行/卸载/再次安装、签名、依赖与许可审计。正式证书仅在受保护的发布环境提供，不进入前端、Git 或交接文件。发布目标和外部发布动作仍需用户授权。

发行前盘点依赖许可：见[依赖与许可清单](licenses.md)（Rust 全树扫描无仅 Copyleft 依赖；Noto Sans SC 为 OFL 1.1，许可全文随包）。界面内置 Noto Sans SC 可变字体约 17.8MB，发行体积相应增加约 10–12MB（压缩后）；若需回退系统字体可移除 `src/assets/fonts` 与 `app.css` 开头的 `@font-face`。

当前已有 `settings-v1.json`、`draft-v1.json`、`history-v1.json`、`output-v1.json`，以及剪贴板图片目录。设置/草稿/历史落盘的原子替换、损坏恢复、清理和版本回退仍待完善，不能按“没有用户数据”处理。草稿命令已存在，前端恢复入口尚未接入；清理内存预览不会清理磁盘剪贴板副本。

## 技能与设计资料

初始化使用独立安装的 build-standard-project 2.1.0；基础界面沿用已有设计和 frontend-design/Figma design-to-code 指引。技能不作为应用依赖，不复制进项目；根 `AGENTS.md` 自包含项目规则。设计样片仅供演示，不进入核心测试数据。当前字体回退系统中文字体，正式发行需补本地字体与许可。
