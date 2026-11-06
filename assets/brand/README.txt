纯钧 / 叠帧 · 方寸 / 品牌资产 v1.0
日期：2026-11-02

设计含义
两个相对的取景折角围住中央像素，表达画面边界、处理前后与精确落点。保留神兵系列名称，以图片语义区别于湛卢的剑形。

主标
mark.svg：标准青绿透明主标。
mark-ink.svg / mark-inverse.svg：石墨单色、纸白反白。
mark-black.svg / mark-white.svg：纯黑与纯白，适合印刷、蒙版和纯色场景。
mark-small*.svg：小尺寸光学版，建议 16–24px 使用。
app-icon.svg / app-icon-light.svg：绿色主应用图标、浅底辅助图标。

组合标
wordmark*.svg：横版、中英组合与竖版，含标准、墨色、反白。发布文件均已将文字转为路径，无需安装字体。Figma 源组件保留可编辑中文与英文文字。
对应 PNG 提供 1x、2x、3x。

桌面图标
raster/app-icon-{16,20,24,32,40,48,64,128,256,512,1024}.png
raster/app-icon.ico：Windows 多尺寸，16、20、24px 使用单独光学校正图像。
raster/app-icon.icns：macOS 图标容器（未来 macOS 适配用，当前桌面设计仍为 Windows）。
favicon.ico；raster/apple-touch-icon.png（180px）。

功能图标
../icons/*.svg：48 枚。24×24 viewBox、1.8px 描边、圆角端点，currentColor 继承界面文字色。
../icons/png-24 与 png-48：对应石墨色 PNG。
../icons/sprite.svg：通过 <use href="sprite.svg#cj-compress"> 引用。
../icons/index.json：文件名与中文含义映射。
有文字标签时图标作装饰；独立图标按钮由产品代码提供明确的无障碍名称。

文件类型
filetypes/：JPG、PNG、WEBP、AVIF、HEIC、TIFF、GIF、SVG 的矢量图及 64/128/256px PNG。

使用规则
1. 保持比例；不旋转、压扁或另加描边、阴影、渐变。
2. 标志有效图形为 64×64，96×96 主标画布已含四周 16px 安全空间。外部元素仍需避开该留白。
3. 小于 24px 只用主标／小尺寸版本；组合标横版建议至少 160px 宽。
4. 浅底使用青绿或石墨，深底使用反白。品牌色：#276650、#252E29、#F7F7F3。
5. Figma 中主标、功能图标均为组件，桌面设计已替换旧剑形标志。

探索
exploration/direction-1.svg 为选定的叠帧方寸；direction-2.svg 双层画片、direction-3.svg 取景之窗仅用于方向留档。它们不是正式主标。

文件内所有 Logo 与图标为 SVG 几何资产；字体文件未随包分发。
