import io

# 1) product README
p = 'docs/product/README.md'
s = io.open(p, encoding='utf8').read()

def sub(old, new):
    global s
    assert old in s, old[:50]
    s = s.replace(old, new, 1)

sub("导出使用原图目录下的纯钧导出子目录，或用户选定的单一文件夹，不保留源目录的层级结构。",
"""导出使用原图目录下的纯钧导出子目录，或用户选定的单一文件夹，不保留源目录的层级结构。导出与预览按「全局参数 + 逐图字段」组合执行：裁剪、旋转/翻转、水印与声明编辑属于具体图片、随该图草稿走，画质/目标体积/缩放/输出格式等跟随当前工作区；任何工作区里点导出处理的都是整个文件列表——在裁剪工作区“应用全部”后“应用并继续”即批量导出，每张按各自原始尺寸换算裁剪。""")

sub("设置页可保存/恢复工作区草稿：文件列表与当时的参数一起还原；撤销支持重做（Ctrl+Shift+Z / Ctrl+Y）。",
"""设置页可保存/恢复工作区草稿：文件列表与当时的参数一起还原；撤销支持重做（Ctrl+Shift+Z / Ctrl+Y）。关闭“保留本机处理记录”后不再保存新记录、历史页显示已关闭说明，已保存的记录不会被删，重新打开开关即恢复显示。""")

sub("优先 Noto Sans SC，当前框架回退系统中文字体；正式发行需完成字体资源与许可。",
"内置 Noto Sans SC 可变字体（100–900，SIL OFL 1.1，许可全文随包），不再依赖系统字体回退。")

io.open(p, 'w', encoding='utf8').write(s)
print('product readme updated')

# 2) engineering README：许可清单与字体体积说明
p = 'docs/engineering/README.md'
s = io.open(p, encoding='utf8').read()

old = "当前已有 `settings-v1.json`、`draft-v1.json`、`history-v1.json`，以及剪贴板图片目录。"
new = """发行前盘点依赖许可：见[依赖与许可清单](licenses.md)（Rust 全树扫描无仅 Copyleft 依赖；Noto Sans SC 为 OFL 1.1，许可全文随包）。界面内置 Noto Sans SC 可变字体约 17.8MB，发行体积相应增加约 10–12MB（压缩后）；若需回退系统字体可移除 `src/assets/fonts` 与 `app.css` 开头的 `@font-face`。

当前已有 `settings-v1.json`、`draft-v1.json`、`history-v1.json`、`output-v1.json`，以及剪贴板图片目录。"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf8').write(s)
print('engineering readme updated')

# 3) handoff
p = '.handoff/开发交接提示词.md'
s = io.open(p, encoding='utf8').read()
old_title = "# 纯钧 · 开发交接提示词（2026-11-06 百张实跑/TIFF 页选择/预算与草稿交付后）"
new_block = """# 纯钧 · 开发交接提示词（2026-11-06 U03/U05/U08 可做项交付后）

请在 `D:\\projects\\vibe\\Chunjun` 继续开发纯钧 Chunjun。先读根 `AGENTS.md`、`docs/product/README.md`、`docs/architecture/README.md`、`docs/reviews/2026-11-04.md`。本轮后：跨工作区组合草稿与批量裁剪导出闭环、关闭历史完整行为、Noto Sans SC 随包、任务栏进度、依赖许可清单均已交付登记。仍需真实环境：代码签名、干净机断网安装/卸载回退、文件关联（需单实例设计）、Figma 逐屏、真实设备样本；OCR/C2PA 与 HEIC/AVIF 解码、WebP 有损按用户指示暂缓。

## 最新交付：跨工作区组合草稿与批量裁剪、关闭历史行为、发行可做项（2026-11-06）

- U03：`mergePerFile` 组合（裁剪/旋转/水印/声明逐图字段 + 全局参数），`editFor`/预览统一走组合；`exportTargets` 改为整张就绪列表——任何工作区导出全部，裁剪“应用全部”+“应用并继续”即批量导出。
- U05：`list_history_inner` 关闭时不列出（数据保留、重开恢复）；前端开关变化即刷新列表，历史页显示“本机记录已关闭”。
- U08：Noto Sans SC 可变字体 17.8MB 随包（jsdelivr 取 Google Fonts 官方仓库，OFL.txt 随包，@font-face 于 app.css，发行体积 +10–12MB）；任务栏进度 `taskbarProgress`/`setTaskbarProgress`（window.ts 纯映射 + App 任务事件驱动，结束清除）；`docs/engineering/licenses.md` 依赖许可清单（直接依赖逐项 + 全树 519 包无仅 Copyleft，r-efi 为三选一含宽松项）。
- 验证：Rust 90、App 40（新增组合/批量/历史开关 3 项）、window 3（新增 2 项）、build 字体进包、clippy -D/fmt/typecheck/lint/prettier/change:check 通过。
- 下载字体时 GitHub raw 超时，用 `cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanssc/` 成功；文件完整性以字节数+magic 校验。

## 上轮交付：百张压力实跑、TIFF 页选择、预算与卷兼容、草稿与重做（2026-11-06）"""
assert old_title in s
s = s.replace(old_title, new_block, 1)

# 去掉旧开头的说明段
old_intro = """请在 `D:\\projects\\vibe\\Chunjun` 继续开发纯钧 Chunjun。先读根 `AGENTS.md`、`docs/product/README.md`、`docs/architecture/README.md`、`docs/reviews/2026-11-04.md`。项目已初始化并有部分图片业务实现。本轮后：100 张混合与取消已有进程内实跑回归；TIFF 可选页；帧/缩放/剪贴板预算、硬链接卷回退、输出目录持久恢复、草稿 UI、撤销重做、过期预览丢弃均已交付登记。用户已指示 OCR/C2PA（U07）与需新原生依赖的格式项（HEIC/AVIF 解码、WebP 有损）暂缓。剩余按 U03 跨工作区组合草稿、U05 关闭历史行为、U08 发行验收与用户新需求逐项交付。

## 上轮交付：百张压力实跑"""
new_intro = "## 上轮交付：百张压力实跑"
assert old_intro in s
s = s.replace(old_intro, new_intro, 1)
io.open(p, 'w', encoding='utf8').write(s)
print('handoff updated')
