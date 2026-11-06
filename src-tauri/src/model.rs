use serde::{Deserialize, Serialize};

pub const MAX_FILE_BYTES: u64 = 80 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 40_000_000;
pub const MAX_IMPORT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Jpeg,
    Png,
    Gif,
    Webp,
    Bmp,
    Tiff,
    Svg,
    Avif,
    Heic,
    Unknown,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Jpeg => "JPEG",
            Self::Png => "PNG",
            Self::Gif => "GIF",
            Self::Webp => "WebP",
            Self::Bmp => "BMP",
            Self::Tiff => "TIFF",
            Self::Svg => "SVG",
            Self::Avif => "AVIF",
            Self::Heic => "HEIC",
            Self::Unknown => "未知",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
            Self::Tiff => "tiff",
            Self::Svg => "svg",
            Self::Avif => "avif",
            Self::Heic => "heic",
            Self::Unknown => "bin",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRecord {
    pub id: String,
    pub name: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub status: String,
    pub message: String,
    pub animated: bool,
    pub pages: u32,
    pub has_alpha: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AigcFields {
    pub label: String,
    pub content_producer: String,
    pub produce_id: String,
    pub reserved_code1: String,
    pub content_propagator: String,
    pub propagate_id: String,
    pub reserved_code2: String,
}

impl AigcFields {
    pub fn is_empty(&self) -> bool {
        [
            &self.label,
            &self.content_producer,
            &self.produce_id,
            &self.reserved_code1,
            &self.content_propagator,
            &self.propagate_id,
            &self.reserved_code2,
        ]
        .iter()
        .all(|value| value.is_empty())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct C2paStatus {
    pub present: bool,
    pub signature: String,
    pub trust: String,
    pub remote: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub aigc: Option<AigcFields>,
    pub auxiliary: Vec<String>,
    pub c2pa: C2paStatus,
    pub icc: String,
    pub orientation: u16,
    pub copyright: String,
    pub notes: Vec<String>,
    /// 可迁移 EXIF 条目数（IFD0 + Exif 子 IFD），0 表示未发现。
    pub exif_fields: u32,
    /// 是否存在 XMP 包。
    pub has_xmp: bool,
    /// 是否存在 PNG 文本块（含 AIGC 文本声明）。
    pub has_text_chunks: bool,
    /// 是否存在 PNG 色彩块（gAMA/sRGB 等）。
    pub has_color_chunks: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Edit {
    pub metadata_only: bool,
    pub quality: u8,
    pub target_kb: u32,
    pub min_quality: u8,
    pub keep_smaller: bool,
    pub skip_if_below_target: bool,
    pub scale_mode: String,
    pub long_edge: u32,
    pub percent: u32,
    pub allow_upscale: bool,
    pub output_format: String,
    pub background: String,
    /// PNG 走调色板（有损）编码。true 时按画质映射色数，否则是无损重编码。
    pub png_lossy: bool,
    pub frame_index: u32,
    pub keep_animation: bool,
    pub use_crop: bool,
    pub crop_x: u32,
    pub crop_y: u32,
    pub crop_w: u32,
    pub crop_h: u32,
    pub rotation: u16,
    pub flip_h: bool,
    pub flip_v: bool,
    pub straighten: i16,
    pub cover: bool,
    pub cover_x: u32,
    pub cover_y: u32,
    pub cover_w: u32,
    pub cover_h: u32,
    pub cover_color: String,
    pub crop_away: bool,
    pub watermark: bool,
    pub watermark_text: String,
    pub watermark_image_id: String,
    pub watermark_mode: String,
    pub anchor: String,
    pub opacity: u8,
    pub angle: i16,
    pub gap: u32,
    pub font_size: u32,
    pub watermark_color: String,
    pub margin: u32,
    pub metadata_policy: String,
    /// 用户在导出确认中明确接受丢弃目标格式无法承载的元数据；Rust 侧仍是最终门禁。
    pub allow_metadata_loss: bool,
    /// AIGC 声明里的来源主体（ContentProducer）。空表示纯钧本地声明。
    pub producer: String,
    pub author: String,
    pub copyright: String,
    pub description: String,
    pub aigc_label: String,
    pub delete_fields: Vec<String>,
    pub prefix: String,
    pub suffix: String,
    pub conflict: String,
    pub svg_width: u32,
}

impl Default for Edit {
    fn default() -> Self {
        Self {
            metadata_only: false,
            quality: 80,
            target_kb: 0,
            min_quality: 40,
            keep_smaller: true,
            skip_if_below_target: false,
            scale_mode: "keep".into(),
            long_edge: 1920,
            percent: 100,
            allow_upscale: false,
            output_format: "keep".into(),
            background: "#FFFFFF".into(),
            png_lossy: true,
            frame_index: 0,
            keep_animation: false,
            use_crop: false,
            crop_x: 0,
            crop_y: 0,
            crop_w: 0,
            crop_h: 0,
            rotation: 0,
            flip_h: false,
            flip_v: false,
            straighten: 0,
            cover: false,
            cover_x: 0,
            cover_y: 0,
            cover_w: 0,
            cover_h: 0,
            cover_color: "#F7F7F3".into(),
            crop_away: false,
            watermark: false,
            watermark_text: String::new(),
            watermark_image_id: String::new(),
            watermark_mode: "single".into(),
            anchor: "se".into(),
            opacity: 48,
            angle: -30,
            gap: 48,
            font_size: 28,
            watermark_color: "#252E29".into(),
            margin: 24,
            metadata_policy: "keep".into(),
            allow_metadata_loss: false,
            producer: String::new(),
            author: String::new(),
            copyright: String::new(),
            description: String::new(),
            aigc_label: "1".into(),
            delete_fields: Vec::new(),
            prefix: String::new(),
            suffix: String::new(),
            conflict: "number".into(),
            svg_width: 1024,
        }
    }
}

impl Edit {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=100).contains(&self.quality) {
            return Err("质量需要在 1 到 100 之间".into());
        }
        if !(1..=100).contains(&self.min_quality)
            || (self.target_kb > 0 && self.min_quality > self.quality)
        {
            return Err("质量下限不能高于当前质量".into());
        }
        if self.percent == 0 || self.percent > 400 {
            return Err("缩放百分比无效".into());
        }
        if !matches!(
            self.output_format.as_str(),
            "keep" | "jpeg" | "png" | "webp" | "avif"
        ) {
            return Err("输出格式无效".into());
        }
        if !matches!(self.rotation, 0 | 90 | 180 | 270) {
            return Err("旋转角度只支持 90 度的倍数".into());
        }
        if !(-45..=45).contains(&self.straighten) {
            return Err("拉直角度需要在 -45 到 45 度之间".into());
        }
        if self.opacity > 100 {
            return Err("透明度需要在 0 到 100 之间".into());
        }
        if !(-180..=180).contains(&self.angle) {
            return Err("水印角度无效".into());
        }
        if !(8..=256).contains(&self.font_size) {
            return Err("字号需要在 8 到 256 之间".into());
        }
        if !matches!(
            self.metadata_policy.as_str(),
            "keep" | "addGeneric" | "addAigc" | "replaceAigc" | "deleteFields"
        ) {
            return Err("元数据策略无效".into());
        }
        if !matches!(self.aigc_label.as_str(), "1" | "2" | "3") {
            return Err("AIGC 标签只接受 1、2 或 3".into());
        }
        if !matches!(self.conflict.as_str(), "number" | "skip" | "replace") {
            return Err("重名策略无效".into());
        }
        if self.scale_mode != "keep" && self.scale_mode != "long" && self.scale_mode != "percent" {
            return Err("缩放方式无效".into());
        }
        if self.watermark
            && self.watermark_text.trim().is_empty()
            && self.watermark_image_id.trim().is_empty()
        {
            return Err("明水印需要文字或一张已导入的图片".into());
        }
        if self.watermark_text.chars().count() > 120 {
            return Err("明水印文字过长".into());
        }
        if self.producer.chars().count() > 40 {
            return Err("声明主体名称过长".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewImage {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewExport {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
    pub encoded_bytes: u64,
    pub below_target: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    pub id: String,
    pub name: String,
    pub state: String,
    pub message: String,
    pub output_name: String,
    pub output_path: String,
    pub bytes: u64,
    pub source_bytes: u64,
    pub saved_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub job_id: String,
    pub success: usize,
    pub skipped: usize,
    pub failed: usize,
    pub below_target: usize,
    /// 取消时未执行的任务数；正常结束为 0。
    pub cancelled: usize,
    pub saved_bytes: i64,
    pub items: Vec<ExportItem>,
    pub output_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub concurrency: u8,
    pub history_enabled: bool,
    pub recursive_folders: bool,
    pub conflict: String,
    pub prefix: String,
    pub suffix: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            concurrency: 1,
            history_enabled: true,
            recursive_folders: false,
            conflict: "number".into(),
            prefix: String::new(),
            suffix: "_纯钧".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub label: String,
    pub success: usize,
    pub failed: usize,
    pub below_target: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub id: String,
    pub edit: Edit,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftView {
    pub files: Vec<FileRecord>,
    pub document: String,
}
