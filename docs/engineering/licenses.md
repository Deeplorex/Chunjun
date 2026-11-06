# 依赖与许可清单

> 生成于 2026-11-06，依赖变化后需重新生成：Rust 用 `cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1`，npm 用 `pnpm licenses list --prod`。
> 本清单是工程盘点记录，不构成法律结论；正式发行前由发布环境复核。

## Rust 直接依赖

| 包                  | 声明版本     | 解析版本 | 许可              |
| ------------------- | ------------ | -------- | ----------------- |
| arboard             | 3.7.0        | 3.7.0    | MIT OR Apache-2.0 |
| base64              | 0.23.1       | 0.23.1   | MIT OR Apache-2.0 |
| color_quant         | 2.0.0        | 2.0.0    | MIT               |
| crc32fast           | 1.5.4        | 1.5.4    | MIT OR Apache-2.0 |
| flate2              | 1.1.10       | 1.1.10   | MIT OR Apache-2.0 |
| image               | 0.25.10      | 0.25.10  | MIT OR Apache-2.0 |
| kamadak-exif        | 0.6          | 0.6.1    | BSD-2-Clause      |
| png                 | 0.18.1       | 0.18.1   | MIT OR Apache-2.0 |
| ravif               | 0.13.0       | 0.13.0   | BSD-3-Clause      |
| resvg               | 0.49.0       | 0.49.0   | Apache-2.0 OR MIT |
| serde               | 1.0.229      | 1.0.229  | MIT OR Apache-2.0 |
| serde_json          | 1.0.154      | 1.0.154  | MIT OR Apache-2.0 |
| swash               | 0.2.10       | 0.2.10   | Apache-2.0 OR MIT |
| tauri               | 2.12.5       | 2.12.5   | Apache-2.0 OR MIT |
| tauri-plugin-dialog | （依赖约束） | 2.8.4    | Apache-2.0 OR MIT |
| tiff                | 0.11         | 0.11.3   | MIT               |

## 全树许可扫描（含传递依赖 519 个包）

- 519 个包为宽松许可或含宽松选项（MIT/Apache/BSD/ISC/Zlib/MPL/BSL/OFL/Unlicense 等）。
- 未发现仅以 GPL/AGPL/LGPL/SSPL/EUPL 等强著作权许可发布的包（r-efi 为 MIT OR Apache-2.0 OR LGPL-2.1 三选一，按宽松项履行即可）。

## npm 直接依赖

以 `pnpm licenses list --prod` 输出为准（React/Vite 生态为 MIT 系；构建工具不进发行物）。

## 随包资源

- Noto Sans SC 可变字体（`src/assets/fonts/NotoSansSC-VF.ttf`，取自 Google Fonts 官方仓库）：SIL Open Font License 1.1，许可全文随包于 `src/assets/fonts/OFL.txt`。OFL 允许捆绑、再分发与修改，禁止单独出售字体文件本身。
- 品牌与图标资产为本项目自有设计（见 `assets/brand`）。
