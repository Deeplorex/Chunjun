use std::io::Cursor;
use std::sync::{Arc, OnceLock};

use image::codecs::gif::GifDecoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::webp::{WebPDecoder, WebPEncoder};
use image::{
    AnimationDecoder, DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageReader,
    Rgba, RgbaImage,
};

use crate::metadata::{self, MetaEdit};
use crate::migration;
use crate::model::{Edit, Kind, PreviewExport, MAX_PIXELS};

#[derive(Debug, Clone)]
pub struct Inspected {
    pub kind: Kind,
    pub width: u32,
    pub height: u32,
    pub animated: bool,
    pub pages: u32,
    pub has_alpha: bool,
    pub status: String,
    pub message: String,
}

pub fn sniff(bytes: &[u8]) -> Kind {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Kind::Jpeg;
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Kind::Png;
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Kind::Gif;
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Kind::Webp;
    }
    if bytes.starts_with(b"BM") {
        return Kind::Bmp;
    }
    if bytes.len() >= 4 && (bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*")) {
        return Kind::Tiff;
    }
    if looks_like_svg(bytes) {
        return Kind::Svg;
    }
    match ftyp_kind(bytes) {
        Some(kind) => kind,
        None => Kind::Unknown,
    }
}

pub fn inspect(bytes: &[u8]) -> Inspected {
    let kind = sniff(bytes);
    match kind {
        Kind::Unknown => Inspected {
            kind,
            width: 0,
            height: 0,
            animated: false,
            pages: 0,
            has_alpha: false,
            status: "failed".into(),
            message: "不是支持的图片".into(),
        },
        Kind::Avif => unsupported(kind, "当前版本未链接 AVIF 解码器，不会改写成其他格式"),
        Kind::Heic => unsupported(kind, "当前版本未链接 HEIC 解码器"),
        Kind::Svg => Inspected {
            kind,
            width: 0,
            height: 0,
            animated: false,
            pages: 1,
            has_alpha: true,
            status: "ready".into(),
            message: "SVG 将在导出时离线栅格化，外部资源和脚本不会加载".into(),
        },
        Kind::Gif => inspect_gif(bytes),
        Kind::Webp => inspect_webp(bytes),
        Kind::Png if png_is_animated(bytes) => {
            unsupported(kind, "当前版本不处理 APNG 动画，不会只保留静态首帧")
        }
        Kind::Tiff => inspect_still(bytes, kind, tiff_pages(bytes)),
        other => inspect_still(bytes, other, 1),
    }
}

fn png_is_animated(bytes: &[u8]) -> bool {
    let mut index = 8usize;
    while index + 12 <= bytes.len() {
        let size = u32::from_be_bytes(bytes[index..index + 4].try_into().unwrap()) as usize;
        if &bytes[index + 4..index + 8] == b"acTL" {
            return true;
        }
        let Some(next) = index
            .checked_add(12)
            .and_then(|offset| offset.checked_add(size))
        else {
            break;
        };
        if next > bytes.len() {
            break;
        }
        index = next;
    }
    false
}

fn unsupported(kind: Kind, message: &str) -> Inspected {
    Inspected {
        kind,
        width: 0,
        height: 0,
        animated: false,
        pages: 0,
        has_alpha: false,
        status: "unsupported".into(),
        message: message.into(),
    }
}

fn inspect_still(bytes: &[u8], kind: Kind, pages: u32) -> Inspected {
    match header(bytes) {
        Ok((width, height, has_alpha)) => {
            let pixels = u64::from(width) * u64::from(height);
            if pixels > MAX_PIXELS {
                return Inspected {
                    kind,
                    width,
                    height,
                    animated: false,
                    pages,
                    has_alpha,
                    status: "failed".into(),
                    message: "图像像素超过 4000 万上限".into(),
                };
            }
            let mut message = String::new();
            if pages > 1 {
                message = format!("TIFF 有 {pages} 页，导出前需要选择页码");
            }
            Inspected {
                kind,
                width,
                height,
                animated: false,
                pages: pages.max(1),
                has_alpha,
                status: "ready".into(),
                message,
            }
        }
        Err(message) => Inspected {
            kind,
            width: 0,
            height: 0,
            animated: false,
            pages,
            has_alpha: false,
            status: "failed".into(),
            message,
        },
    }
}

fn inspect_gif(bytes: &[u8]) -> Inspected {
    let frames = gif_frames(bytes).unwrap_or(1);
    match header(bytes) {
        Ok((width, height, _)) => Inspected {
            kind: Kind::Gif,
            width,
            height,
            animated: frames > 1,
            pages: frames,
            has_alpha: true,
            status: "ready".into(),
            message: if frames > 1 {
                "动画不会静默丢帧，请保留原文件或指定帧".into()
            } else {
                String::new()
            },
        },
        Err(message) => Inspected {
            kind: Kind::Gif,
            width: 0,
            height: 0,
            animated: frames > 1,
            pages: frames,
            has_alpha: true,
            status: "failed".into(),
            message,
        },
    }
}

fn inspect_webp(bytes: &[u8]) -> Inspected {
    let animated = bytes.len() > 20 && &bytes[12..16] == b"VP8X" && bytes[20] & 0x02 != 0;
    match header(bytes) {
        Ok((width, height, has_alpha)) => Inspected {
            kind: Kind::Webp,
            width,
            height,
            animated,
            pages: if animated { 0 } else { 1 },
            has_alpha,
            status: "ready".into(),
            message: if animated {
                "动画 WebP 不会静默丢帧，请保留原文件或指定帧".into()
            } else {
                "WebP 导出走无损编码，质量滑杆不改变有损压缩率".into()
            },
        },
        Err(message) => Inspected {
            kind: Kind::Webp,
            width: 0,
            height: 0,
            animated,
            pages: 1,
            has_alpha: false,
            status: "failed".into(),
            message,
        },
    }
}

fn header(bytes: &[u8]) -> Result<(u32, u32, bool), String> {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_000);
    limits.max_image_height = Some(16_000);
    limits.max_alloc = Some(160 * 1024 * 1024);
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("无法识别图像：{error}"))?;
    let mut reader = reader;
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|error| format!("图像已损坏或无法读取：{error}"))?;
    let (width, height) = decoder.dimensions();
    let has_alpha = decoder.color_type().has_alpha();
    Ok((width, height, has_alpha))
}

/// 处理阶段回调：阶段名 + 该张图片内的完成度（0..1）。
/// 只用来推进度条，不参与任何结果判断。
pub type Stage<'a> = &'a dyn Fn(&str, f32);

#[derive(Debug)]
pub struct Processed {
    pub width: u32,
    pub height: u32,
    pub encoded: Vec<u8>,
    pub preview: Vec<u8>,
    pub below_target: bool,
    pub message: String,
    pub kind: Kind,
}

pub fn process(
    original: &[u8],
    edit: &Edit,
    source_kind: Kind,
    mark: Option<&[u8]>,
) -> Result<Processed, String> {
    process_with_stage(original, edit, source_kind, mark, &|_, _| {})
}

pub fn process_with_stage(
    original: &[u8],
    edit: &Edit,
    source_kind: Kind,
    mark: Option<&[u8]>,
    stage: Stage<'_>,
) -> Result<Processed, String> {
    edit.validate()?;
    let inspected = inspect(original);
    if inspected.status != "ready" {
        return Err(inspected.message);
    }
    let kind = if source_kind == Kind::Unknown {
        inspected.kind
    } else {
        source_kind
    };
    if edit.metadata_only {
        return finish_bytes(
            original.to_vec(),
            kind,
            "仅改写元数据，未重新编码像素。",
            false,
            edit,
        );
    }
    if (inspected.animated || inspected.pages > 1) && edit.keep_animation {
        if geometry_changed(edit) || output_kind(edit, kind) != kind {
            return Err("保留动画或原文件时不能同时裁剪、加水印或转换格式".into());
        }
        return finish_bytes(
            original.to_vec(),
            kind,
            "已保留原文件。预览只显示第一帧，文件字节未改。",
            false,
            edit,
        );
    }
    if inspected.animated && edit.frame_index == 0 {
        return Err("请选择保留原文件或指定帧，不会静默丢帧".into());
    }
    if inspected.pages > 1 && !inspected.animated && edit.frame_index == 0 {
        return Err("请选择 TIFF 页，不会默认只留首页".into());
    }
    stage("解码", 0.08);
    let mut image = decode(original, kind, edit)?;
    stage("应用参数", 0.3);
    image = apply_geometry(image, edit)?;
    image = scale_image(image, edit)?;
    if edit.watermark {
        draw_watermark(&mut image, edit, mark)?;
    }
    let target = u64::from(edit.target_kb) * 1024;
    if edit.skip_if_below_target
        && target > 0
        && (original.len() as u64) <= target
        && !geometry_changed(edit)
    {
        return finish_bytes(
            original.to_vec(),
            kind,
            "源文件已小于目标体积，已跳过",
            false,
            edit,
        );
    }
    let output_kind = output_kind(edit, kind);
    stage("编码", 0.45);
    let (mut encoded, mut note) = encode_with_target(&image, output_kind, edit, stage)?;
    stage("校验结果", 0.9);
    let mut below = target > 0 && encoded.len() as u64 > target;
    if edit.keep_smaller
        && !geometry_changed(edit)
        && output_kind == kind
        && encoded.len() >= original.len()
    {
        encoded = original.to_vec();
        note = "重新编码没有更小，已保留较小的源文件字节".into();
        below = target > 0 && encoded.len() as u64 > target;
    }
    if below {
        note = format!(
            "{note}{}结果 {} 字节，仍高于目标。这不是达标。",
            if note.is_empty() { "" } else { " " },
            encoded.len()
        );
    }
    let meta = MetaEdit {
        policy: edit.metadata_policy.clone(),
        author: edit.author.clone(),
        copyright: edit.copyright.clone(),
        description: edit.description.clone(),
        aigc_label: edit.aigc_label.clone(),
        producer: edit.producer.clone(),
        delete_fields: edit.delete_fields.clone(),
    };
    let include_xmp = meta.policy == "keep";
    let source_containers = if encoded != original {
        let mut containers = migration::extract(original, kind);
        // 多页 TIFF 选了第 2 页及以后：EXIF/ICC 属于第 1 页的 IFD0，不能张冠李戴
        // 地挂到所选页的副本上；XMP 是文档级声明，仍然迁移。
        if kind == Kind::Tiff
            && inspected.pages > 1
            && edit.frame_index > 1
            && (containers.exif_tiff.is_some() || containers.icc_raw.is_some())
        {
            containers.exif_tiff = None;
            containers.icc_raw = None;
            containers.icc_png_chunk = None;
            containers.tiff_foreign_page = true;
        }
        Some(containers)
    } else {
        None
    };
    if let Some(containers) = source_containers.as_ref() {
        if !include_xmp && !containers.xmp.is_empty() {
            // 与元数据页同一门槛：未知或多份 XMP 不允许在重编码时被顺手替换。
            metadata::ensure_editable_xmp(original, kind)?;
        }
    }
    if !include_xmp {
        encoded = metadata::apply_metadata(&encoded, output_kind, &meta)?;
    }
    if let Some(containers) = source_containers.as_ref() {
        // 容器迁移：EXIF/ICC/XMP 与 PNG 文本、色彩块逐字节搬运，写入后立即复检。
        if containers.has_carriable() || containers.c2pa_clue {
            let uncarrivable = migration::uncarrivable(containers, output_kind, include_xmp);
            if !uncarrivable.is_empty() && !edit.allow_metadata_loss {
                return Err(format!(
                    "目标格式 {} 无法承载 {}；请改用 JPEG/PNG 等能承载的格式，或在导出确认中明确选择不保留这些字段。",
                    output_kind.label(),
                    uncarrivable.join("、")
                ));
            }
            let mut migrated = String::new();
            if matches!(output_kind, Kind::Jpeg | Kind::Png) {
                let orientation_observed = metadata::read_orientation(original);
                let carried = migration::carry_into(
                    &mut encoded,
                    output_kind,
                    containers,
                    include_xmp,
                    orientation_observed,
                    (image.width(), image.height()),
                )?;
                migration::verify(&encoded, output_kind, &carried)?;
                let mut parts = Vec::new();
                if carried.exif_fields > 0 {
                    parts.push(format!("EXIF（{} 字段）", carried.exif_fields));
                }
                if carried.icc {
                    parts.push("ICC 色彩配置".into());
                }
                if carried.xmp_packets > 0 {
                    parts.push(format!("XMP（{} 包）", carried.xmp_packets));
                }
                if carried.png_chunks > 0 {
                    parts.push(format!("PNG 文本/色彩块（{} 项）", carried.png_chunks));
                }
                if !parts.is_empty() {
                    migrated = format!("已迁移并复检 {}。", parts.join("、"));
                }
            }
            if !uncarrivable.is_empty() {
                migrated.push_str(&format!("已按确认不保留：{}。", uncarrivable.join("、")));
            }
            if containers.c2pa_clue {
                migrated.push_str(
                    "原件的 C2PA 字节线索不随副本保留：重编码使内容凭证失效，其签名本就未验证。",
                );
            }
            if !migrated.is_empty() {
                note = if note.is_empty() {
                    migrated
                } else {
                    format!("{note} {migrated}")
                };
            }
        }
    }
    below = target > 0 && encoded.len() as u64 > target;
    if below && !note.contains("这不是达标") {
        note = format!("{note} 最终文件 {} 字节，未达到目标体积。", encoded.len());
    }
    if !edit.producer.trim().is_empty()
        && edit.metadata_policy != "keep"
        && edit.metadata_policy != "addGeneric"
    {
        note = format!(
            "{} 声明主体「{}」由本地写入，纯钧不做核验；编号仍是 chunjun 前缀，不是厂商原始编号。",
            if note.is_empty() { "" } else { " " },
            edit.producer.trim()
        );
    }
    let evidence = metadata::read_evidence(&encoded);
    if evidence
        .aigc
        .as_ref()
        .is_some_and(|fields| fields.produce_id.starts_with("chunjun-"))
    {
        note = format!("{note} 编号属于纯钧，不是原厂编号。");
    }
    let preview = if output_kind == Kind::Avif {
        note = format!("{note} AVIF 尚无解码器，预览为编码前像素；字节回读不代表解码复检。");
        preview_png(&image)?
    } else {
        preview_png(&decode(&encoded, output_kind, &Edit::default())?)?
    };
    stage("生成预览", 0.97);
    Ok(Processed {
        width: image.width(),
        height: image.height(),
        encoded,
        preview,
        below_target: below,
        message: note,
        kind: output_kind,
    })
}

fn finish_bytes(
    bytes: Vec<u8>,
    kind: Kind,
    message: &str,
    _below_target: bool,
    edit: &Edit,
) -> Result<Processed, String> {
    let meta = MetaEdit {
        policy: edit.metadata_policy.clone(),
        author: edit.author.clone(),
        copyright: edit.copyright.clone(),
        description: edit.description.clone(),
        aigc_label: edit.aigc_label.clone(),
        producer: edit.producer.clone(),
        delete_fields: edit.delete_fields.clone(),
    };
    let encoded = if meta.policy == "keep" {
        bytes
    } else {
        metadata::apply_metadata(&bytes, kind, &meta)?
    };
    let image = decode(&encoded, kind, &Edit::default())
        .unwrap_or_else(|_| RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 0])));
    let below_target =
        edit.target_kb > 0 && encoded.len() as u64 > u64::from(edit.target_kb) * 1024;
    Ok(Processed {
        width: image.width(),
        height: image.height(),
        preview: preview_png(&image)?,
        encoded,
        below_target,
        message: message.into(),
        kind,
    })
}

pub fn preview_export(
    original: &[u8],
    edit: &Edit,
    source_kind: Kind,
    mark: Option<&[u8]>,
) -> Result<PreviewExport, String> {
    let processed = process(original, edit, source_kind, mark)?;
    Ok(PreviewExport {
        png_base64: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &processed.preview,
        ),
        width: processed.width,
        height: processed.height,
        encoded_bytes: processed.encoded.len() as u64,
        below_target: processed.below_target,
        message: processed.message,
    })
}

pub fn preview_png_base64(bytes: &[u8], kind: Kind) -> Result<(String, u32, u32), String> {
    let image = decode(
        bytes,
        kind,
        &Edit {
            frame_index: 1,
            keep_animation: false,
            ..Edit::default()
        },
    )?;
    let png = preview_png(&image)?;
    Ok((
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png),
        image.width(),
        image.height(),
    ))
}

/// 处理记录里的缩略图：只给前端一个很小的 PNG，避免每行都塞一张大图。
pub fn thumb_png_base64(bytes: &[u8], kind: Kind, max_edge: u32) -> Result<String, String> {
    let image = decode(
        bytes,
        kind,
        &Edit {
            frame_index: 1,
            keep_animation: false,
            ..Edit::default()
        },
    )?;
    let png = encode_png_small(&fit_long_edge(&image, max_edge.max(16)))?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        png,
    ))
}

fn fit_long_edge(image: &RgbaImage, long_edge: u32) -> RgbaImage {
    let long = image.width().max(image.height());
    if long <= long_edge {
        return image.clone();
    }
    let scale = long_edge as f32 / long as f32;
    image::imageops::resize(
        image,
        ((image.width() as f32) * scale).round().max(1.0) as u32,
        ((image.height() as f32) * scale).round().max(1.0) as u32,
        image::imageops::FilterType::Triangle,
    )
}

fn encode_png_small(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    DynamicImage::ImageRgba8(image.clone())
        .write_with_encoder(PngEncoder::new(&mut bytes))
        .map_err(|error| format!("预览编码失败：{error}"))?;
    Ok(bytes)
}

fn geometry_changed(edit: &Edit) -> bool {
    edit.use_crop
        || edit.rotation != 0
        || edit.flip_h
        || edit.flip_v
        || edit.straighten != 0
        || edit.cover
        || edit.crop_away
        || edit.watermark
        || edit.scale_mode != "keep"
        || edit.frame_index > 0
}

fn output_kind(edit: &Edit, source: Kind) -> Kind {
    match edit.output_format.as_str() {
        "jpeg" => Kind::Jpeg,
        "png" => Kind::Png,
        "webp" => Kind::Webp,
        "avif" => Kind::Avif,
        _ => match source {
            Kind::Jpeg | Kind::Png | Kind::Webp | Kind::Avif => source,
            _ => Kind::Png,
        },
    }
}

fn decode(bytes: &[u8], kind: Kind, edit: &Edit) -> Result<RgbaImage, String> {
    if kind == Kind::Svg {
        return decode_svg(bytes, edit.svg_width.max(1));
    }
    if (kind == Kind::Gif || kind == Kind::Webp || kind == Kind::Tiff) && edit.frame_index > 0 {
        return decode_frame(bytes, kind, edit.frame_index);
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_000);
    limits.max_image_height = Some(16_000);
    limits.max_alloc = Some(160 * 1024 * 1024);
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("无法读取图像：{error}"))?;
    let mut reader = reader;
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("图像已损坏或无法解码：{error}"))?
        .to_rgba8();
    if u64::from(image.width()) * u64::from(image.height()) > MAX_PIXELS {
        return Err("图像像素超过 4000 万上限".into());
    }
    Ok(apply_orientation(
        image,
        metadata::read_evidence(bytes).orientation,
    ))
}

/// 帧提取的累计解码像素预算：跳过的帧也要逐帧解码，超长动画不能把内存吃满。
const FRAME_PIXEL_BUDGET: u64 = 400_000_000;

fn decode_frame(bytes: &[u8], kind: Kind, frame_index: u32) -> Result<RgbaImage, String> {
    match kind {
        Kind::Gif => {
            let frames = GifDecoder::new(Cursor::new(bytes))
                .map_err(|error| format!("GIF 无法读取：{error}"))?
                .into_frames();
            nth_frame("GIF", frames, frame_index, FRAME_PIXEL_BUDGET)
        }
        Kind::Webp => {
            let frames = WebPDecoder::new(Cursor::new(bytes))
                .map_err(|error| format!("WebP 无法读取：{error}"))?
                .into_frames();
            nth_frame("WebP", frames, frame_index, FRAME_PIXEL_BUDGET)
        }
        Kind::Tiff => decode_tiff_page(bytes, frame_index),
        _ => Err("该格式没有可提取的帧".into()),
    }
}

/// 逐帧惰性解码到第 `frame_index` 帧（1 起）。不把全部帧收进内存；跳过的帧
/// 计入像素预算，超预算即拒绝，给出可操作的提示。
fn nth_frame<'frames, I>(
    label: &str,
    frames: I,
    frame_index: u32,
    budget: u64,
) -> Result<RgbaImage, String>
where
    I: Iterator<Item = Result<image::Frame, image::ImageError>> + 'frames,
{
    let target = frame_index.saturating_sub(1) as usize;
    let mut spent = 0u64;
    for (index, frame) in frames.enumerate() {
        let frame = frame.map_err(|error| format!("{label} 帧无法读取：{error}"))?;
        if index == target {
            return Ok(frame.into_buffer());
        }
        let (width, height) = frame.buffer().dimensions();
        spent += u64::from(width) * u64::from(height);
        if spent > budget {
            return Err(format!(
                "跳到第 {frame_index} 帧需要累计解码超过预算的像素；请保留原文件或提取更靠前的帧"
            ));
        }
    }
    Err("指定帧超出范围".into())
}

/// TIFF 指定页（1 起）：直接用 tiff 解码器翻目录，多页文件不必只读首页。
fn decode_tiff_page(bytes: &[u8], page: u32) -> Result<RgbaImage, String> {
    use tiff::decoder::DecodingResult;
    use tiff::ColorType;
    let mut decoder = tiff::decoder::Decoder::new(Cursor::new(bytes))
        .map_err(|error| format!("TIFF 无法读取：{error}"))?;
    let target = page.saturating_sub(1);
    for _ in 0..target {
        if !decoder.more_images() {
            return Err("指定 TIFF 页超出范围".into());
        }
        decoder
            .next_image()
            .map_err(|error| format!("TIFF 翻页失败：{error}"))?;
    }
    let (width, height) = decoder
        .dimensions()
        .map_err(|error| format!("TIFF 页无法读取尺寸：{error}"))?;
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("TIFF 页像素超过 4000 万上限".into());
    }
    let color = decoder
        .colortype()
        .map_err(|error| format!("TIFF 页无法读取色彩类型：{error}"))?;
    let buffer = decoder
        .read_image()
        .map_err(|error| format!("TIFF 页无法解码：{error}"))?;
    let direct = |bytes: Vec<u8>| {
        RgbaImage::from_raw(width, height, bytes)
            .ok_or_else(|| "TIFF 页数据与尺寸不一致".to_string())
    };
    let gray = |bytes: Vec<u8>| -> Result<RgbaImage, String> {
        let buffer =
            image::GrayImage::from_raw(width, height, bytes).ok_or("TIFF 页数据与尺寸不一致")?;
        Ok(DynamicImage::ImageLuma8(buffer).to_rgba8())
    };
    let rgb = |bytes: Vec<u8>| -> Result<RgbaImage, String> {
        let buffer =
            image::RgbImage::from_raw(width, height, bytes).ok_or("TIFF 页数据与尺寸不一致")?;
        Ok(DynamicImage::ImageRgb8(buffer).to_rgba8())
    };
    let downscale =
        |bytes: Vec<u16>| -> Vec<u8> { bytes.iter().map(|value| (value >> 8) as u8).collect() };
    match (color, buffer) {
        (ColorType::RGBA(8), DecodingResult::U8(bytes)) => direct(bytes),
        (ColorType::RGB(8), DecodingResult::U8(bytes)) => rgb(bytes),
        (ColorType::Gray(8), DecodingResult::U8(bytes)) => gray(bytes),
        (ColorType::Gray(16), DecodingResult::U16(bytes)) => gray(downscale(bytes)),
        (ColorType::RGB(16), DecodingResult::U16(bytes)) => rgb(downscale(bytes)),
        (ColorType::RGBA(16), DecodingResult::U16(bytes)) => direct(downscale(bytes)),
        _ => Err("这页 TIFF 的色彩布局本版暂不支持".into()),
    }
}

fn decode_svg(bytes: &[u8], width_hint: u32) -> Result<RgbaImage, String> {
    let mut options = resvg::usvg::Options {
        resources_dir: None,
        ..resvg::usvg::Options::default()
    };
    options.image_href_resolver.resolve_string = Box::new(|_, _| None);
    let tree = resvg::usvg::Tree::from_data(bytes, &options)
        .map_err(|error| format!("SVG 无法解析：{error}"))?;
    let size = tree.size();
    let source_w = size.width().ceil().max(1.0);
    let source_h = size.height().ceil().max(1.0);
    let width = width_hint.clamp(1, 4096);
    let height = ((source_h * width as f32 / source_w).ceil() as u32).clamp(1, 4096);
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height).ok_or("SVG 尺寸无效")?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(width as f32 / source_w, height as f32 / source_h),
        &mut pixmap.as_mut(),
    );
    RgbaImage::from_raw(width, height, pixmap.take()).ok_or_else(|| "SVG 栅格化失败".into())
}

fn apply_orientation(image: RgbaImage, orientation: u16) -> RgbaImage {
    use image::imageops::{flip_horizontal, flip_vertical, rotate180, rotate270, rotate90};
    match orientation {
        2 => flip_horizontal(&image),
        3 => rotate180(&image),
        4 => flip_vertical(&image),
        5 => flip_horizontal(&rotate90(&image)),
        6 => rotate90(&image),
        7 => flip_horizontal(&rotate270(&image)),
        8 => rotate270(&image),
        _ => image,
    }
}

fn apply_geometry(mut image: RgbaImage, edit: &Edit) -> Result<RgbaImage, String> {
    use image::imageops::{flip_horizontal, flip_vertical, rotate180, rotate270, rotate90};
    image = match edit.rotation {
        90 => rotate90(&image),
        180 => rotate180(&image),
        270 => rotate270(&image),
        _ => image,
    };
    if edit.flip_h {
        image = flip_horizontal(&image);
    }
    if edit.flip_v {
        image = flip_vertical(&image);
    }
    if edit.straighten != 0 {
        image = rotate_arbitrary(&image, edit.straighten as f32);
    }
    if edit.use_crop {
        image = crop_keep(&image, edit.crop_x, edit.crop_y, edit.crop_w, edit.crop_h)?;
    }
    if edit.crop_away {
        image = crop_away(
            &image,
            edit.cover_x,
            edit.cover_y,
            edit.cover_w,
            edit.cover_h,
        )?;
    } else if edit.cover {
        fill_rect(
            &mut image,
            edit.cover_x,
            edit.cover_y,
            edit.cover_w,
            edit.cover_h,
            parse_color(&edit.cover_color)?,
        )?;
    }
    Ok(image)
}

fn crop_keep(
    image: &RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<RgbaImage, String> {
    if width == 0 || height == 0 {
        return Err("裁剪宽高需要大于 0".into());
    }
    let x = x.min(image.width().saturating_sub(1));
    let y = y.min(image.height().saturating_sub(1));
    let width = width.min(image.width() - x).max(1);
    let height = height.min(image.height() - y).max(1);
    Ok(image::imageops::crop_imm(image, x, y, width, height).to_image())
}

fn crop_away(
    image: &RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<RgbaImage, String> {
    if width == 0 || height == 0 {
        return Err("裁掉区域宽高需要大于 0".into());
    }
    if x.saturating_add(width) > image.width() || y.saturating_add(height) > image.height() {
        return Err("裁掉区域超出图像".into());
    }
    let full_width = width == image.width();
    let full_height = height == image.height();
    if full_width && y == 0 {
        return crop_keep(image, 0, height, image.width(), image.height() - height);
    }
    if full_width && y + height == image.height() {
        return crop_keep(image, 0, 0, image.width(), y);
    }
    if full_height && x == 0 {
        return crop_keep(image, width, 0, image.width() - width, image.height());
    }
    if full_height && x + width == image.width() {
        return crop_keep(image, 0, 0, x, image.height());
    }
    Err("裁掉只适用于贴边并贯通整边的区域，内部区域请改用纯色覆盖".into())
}

fn fill_rect(
    image: &mut RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: Rgba<u8>,
) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("覆盖区域宽高需要大于 0".into());
    }
    if x.saturating_add(width) > image.width() || y.saturating_add(height) > image.height() {
        return Err("覆盖区域超出图像".into());
    }
    for py in y..y + height {
        for px in x..x + width {
            image.put_pixel(px, py, color);
        }
    }
    Ok(())
}

fn scale_image(image: RgbaImage, edit: &Edit) -> Result<RgbaImage, String> {
    let (width, height) = (image.width(), image.height());
    let (target_w, target_h) = match edit.scale_mode.as_str() {
        "keep" => return Ok(image),
        "percent" => {
            let scale = edit.percent as f32 / 100.0;
            (
                ((width as f32) * scale).round().max(1.0) as u32,
                ((height as f32) * scale).round().max(1.0) as u32,
            )
        }
        "long" => {
            let long = width.max(height);
            if edit.long_edge == 0 {
                return Err("长边限制无效".into());
            }
            if long <= edit.long_edge && !edit.allow_upscale {
                return Ok(image);
            }
            let scale = edit.long_edge as f32 / long as f32;
            (
                ((width as f32) * scale).round().max(1.0) as u32,
                ((height as f32) * scale).round().max(1.0) as u32,
            )
        }
        _ => return Err("缩放方式无效".into()),
    };
    if (target_w > width || target_h > height) && !edit.allow_upscale {
        return Ok(image);
    }
    // 缩放输出也要过像素预算：400% 放大 4000 万像素原图会直接吃满内存。
    if u64::from(target_w) * u64::from(target_h) > MAX_PIXELS {
        return Err(format!(
            "缩放到 {target_w}×{target_h} 会超过 4000 万像素上限，请减小目标尺寸"
        ));
    }
    Ok(image::imageops::resize(
        &image,
        target_w,
        target_h,
        image::imageops::FilterType::Triangle,
    ))
}

fn rotate_arbitrary(source: &RgbaImage, degrees: f32) -> RgbaImage {
    let radians = degrees.to_radians();
    let (sin, cos) = radians.sin_cos();
    let width = source.width() as f32;
    let height = source.height() as f32;
    let bound_w = (width * cos.abs() + height * sin.abs()).ceil().max(1.0) as u32;
    let bound_h = (width * sin.abs() + height * cos.abs()).ceil().max(1.0) as u32;
    let mut canvas = RgbaImage::from_pixel(bound_w, bound_h, Rgba([0, 0, 0, 0]));
    let center_x = (bound_w as f32 - 1.0) / 2.0;
    let center_y = (bound_h as f32 - 1.0) / 2.0;
    let source_cx = (width - 1.0) / 2.0;
    let source_cy = (height - 1.0) / 2.0;
    for y in 0..bound_h {
        for x in 0..bound_w {
            let dx = x as f32 - center_x;
            let dy = y as f32 - center_y;
            let sx = dx * cos + dy * sin + source_cx;
            let sy = -dx * sin + dy * cos + source_cy;
            if let Some(pixel) = sample_bilinear(source, sx, sy) {
                canvas.put_pixel(x, y, pixel);
            }
        }
    }
    let (crop_w, crop_h) = inscribed_size(width, height, radians.abs());
    if crop_w < 1.0 || crop_h < 1.0 {
        return canvas;
    }
    let crop_w = crop_w.floor().max(1.0) as u32;
    let crop_h = crop_h.floor().max(1.0) as u32;
    let x = bound_w.saturating_sub(crop_w) / 2;
    let y = bound_h.saturating_sub(crop_h) / 2;
    if x + crop_w > bound_w || y + crop_h > bound_h {
        return canvas;
    }
    image::imageops::crop_imm(&canvas, x, y, crop_w, crop_h).to_image()
}

fn inscribed_size(width: f32, height: f32, angle: f32) -> (f32, f32) {
    let (sin_a, cos_a) = (angle.sin().abs(), angle.cos().abs());
    if sin_a < 0.0001 || cos_a < 0.0001 {
        return (width, height);
    }
    let (side_long, side_short, width_longer) = if width >= height {
        (width, height, true)
    } else {
        (height, width, false)
    };
    if side_short <= 2.0 * sin_a * cos_a * side_long {
        let half = 0.5 * side_short;
        if width_longer {
            (half / sin_a, half / cos_a)
        } else {
            (half / cos_a, half / sin_a)
        }
    } else {
        let cos2 = cos_a * cos_a - sin_a * sin_a;
        if cos2.abs() < 0.0001 {
            return (width * 0.5, height * 0.5);
        }
        (
            (width * cos_a - height * sin_a) / cos2,
            (height * cos_a - width * sin_a) / cos2,
        )
    }
}

fn sample_bilinear(image: &RgbaImage, x: f32, y: f32) -> Option<Rgba<u8>> {
    if x < 0.0 || y < 0.0 || x >= image.width() as f32 - 1.0 || y >= image.height() as f32 - 1.0 {
        return None;
    }
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let dx = x - x0 as f32;
    let dy = y - y0 as f32;
    let p00 = image.get_pixel(x0, y0).0;
    let p10 = image.get_pixel(x0 + 1, y0).0;
    let p01 = image.get_pixel(x0, y0 + 1).0;
    let p11 = image.get_pixel(x0 + 1, y0 + 1).0;
    let mut out = [0u8; 4];
    for channel in 0..4 {
        let top = p00[channel] as f32 * (1.0 - dx) + p10[channel] as f32 * dx;
        let bottom = p01[channel] as f32 * (1.0 - dx) + p11[channel] as f32 * dx;
        out[channel] = (top * (1.0 - dy) + bottom * dy).round().clamp(0.0, 255.0) as u8;
    }
    Some(Rgba(out))
}

fn encode_with_target(
    image: &RgbaImage,
    kind: Kind,
    edit: &Edit,
    stage: Stage<'_>,
) -> Result<(Vec<u8>, String), String> {
    let target = u64::from(edit.target_kb) * 1024;
    let mut quality = edit.quality;
    let mut encoded = encode_image(image, kind, quality, edit, &|name, fraction| {
        stage(name, 0.45 + fraction * 0.4)
    })?;
    let mut attempts = 0;
    let steppable =
        matches!(kind, Kind::Jpeg | Kind::Avif) || (kind == Kind::Png && edit.png_lossy);
    while target > 0 && encoded.len() as u64 > target && quality > edit.min_quality && attempts < 6
    {
        if !steppable {
            break;
        }
        let next = if kind == Kind::Png {
            // PNG 的色数按画质分档，逐档退比每 8 分重算一次更省时间。
            next_png_quality(quality, edit.min_quality)
        } else {
            quality.saturating_sub(8).max(edit.min_quality)
        };
        if next >= quality {
            break;
        }
        quality = next;
        stage("按目标体积重编码", 0.78);
        let candidate = encode_image(image, kind, quality, edit, &|_, _| {})?;
        if candidate.len() < encoded.len() {
            encoded = candidate;
        }
        attempts += 1;
    }
    let mut notes: Vec<String> = Vec::new();
    match kind {
        Kind::Webp => notes.push("WebP 使用无损编码。".into()),
        Kind::Avif => notes.push("AVIF 由本地 rav1e 编码。".into()),
        Kind::Png if edit.png_lossy && quality < 100 => notes.push(format!(
            "PNG 已按 {} 色调色板有损重编码。",
            png_palette_size(quality)
        )),
        _ => {}
    }
    if target > 0 && encoded.len() as u64 > target {
        notes.push(format!("最小得到 {} 字节，未达到目标体积。", encoded.len()));
    }
    Ok((encoded, notes.join(" ")))
}

fn encode_image(
    image: &RgbaImage,
    kind: Kind,
    quality: u8,
    edit: &Edit,
    stage: Stage<'_>,
) -> Result<Vec<u8>, String> {
    let working = image.clone();
    let mut bytes = Vec::new();
    match kind {
        Kind::Jpeg => {
            let flat = flatten(&working, parse_color(&edit.background)?);
            let mut encoder = JpegEncoder::new_with_quality(&mut bytes, quality);
            encoder
                .encode(
                    flat.as_raw(),
                    flat.width(),
                    flat.height(),
                    ExtendedColorType::Rgb8,
                )
                .map_err(|error| format!("JPEG 编码失败：{error}"))?;
        }
        Kind::Png => {
            if edit.png_lossy && quality < 100 {
                bytes = encode_png_palette(&working, quality, stage)?;
            } else {
                let encoder = PngEncoder::new_with_quality(
                    &mut bytes,
                    CompressionType::Best,
                    FilterType::Adaptive,
                );
                encoder
                    .write_image(
                        working.as_raw(),
                        working.width(),
                        working.height(),
                        ExtendedColorType::Rgba8,
                    )
                    .map_err(|error| format!("PNG 编码失败：{error}"))?;
            }
        }
        Kind::Webp => {
            let encoder = WebPEncoder::new_lossless(&mut bytes);
            encoder
                .encode(
                    working.as_raw(),
                    working.width(),
                    working.height(),
                    ExtendedColorType::Rgba8,
                )
                .map_err(|error| format!("WebP 编码失败：{error}"))?;
        }
        Kind::Avif => {
            let pixels: Vec<ravif::RGBA8> = working
                .pixels()
                .map(|pixel| ravif::RGBA8::new(pixel[0], pixel[1], pixel[2], pixel[3]))
                .collect();
            let encoded = ravif::Encoder::new()
                .with_quality(quality as f32)
                .with_speed(6)
                .encode_rgba(ravif::Img::new(
                    pixels.as_slice(),
                    working.width() as usize,
                    working.height() as usize,
                ))
                .map_err(|error| format!("AVIF 编码失败：{error}"))?;
            bytes = encoded.avif_file;
        }
        _ => return Err("该格式不能作为导出格式".into()),
    }
    Ok(bytes)
}

/// 按体积压缩时，PNG 直接跳到下一档色数，省掉同档内的重复编码。
fn next_png_quality(quality: u8, floor: u8) -> u8 {
    let next = match quality {
        75..=100 => 74,
        60..=74 => 59,
        45..=59 => 44,
        30..=44 => 29,
        15..=29 => 14,
        _ => 1,
    };
    next.max(floor)
}

/// PNG 是索引色格式：所谓“有损压缩”就是把真彩降到调色板。画质决定色板大小。
/// 这里不做误差扩散抖动——抖动会引入高频噪点，DEFLATE 反而压不动，
/// 实测在 12MP 照片上体积会翻倍，所以只降色、不加噪点。
fn png_palette_size(quality: u8) -> usize {
    match quality {
        90..=100 => 256,
        75..=89 => 192,
        60..=74 => 128,
        45..=59 => 96,
        30..=44 => 64,
        15..=29 => 48,
        _ => 32,
    }
}

fn encode_png_palette(image: &RgbaImage, quality: u8, stage: Stage<'_>) -> Result<Vec<u8>, String> {
    let colors = png_palette_size(quality);
    let width = image.width() as usize;
    let height = image.height() as usize;
    let source = image.as_raw();
    let has_alpha = image.pixels().any(|pixel| pixel[3] < 255);

    stage("量化调色板", 0.1);
    let quantizer = color_quant::NeuQuant::new(10, colors, source);
    stage("映射颜色", 0.55);
    let mut indices = vec![0u8; width * height];
    let mut alpha_sum = vec![0u64; colors];
    let mut alpha_count = vec![0u64; colors];
    for (offset, chunk) in source.as_chunks::<4>().0.iter().enumerate() {
        let index = quantizer.index_of(chunk);
        indices[offset] = index as u8;
        if has_alpha {
            alpha_sum[index] += u64::from(chunk[3]);
            alpha_count[index] += 1;
        }
    }

    let map = quantizer.color_map_rgba();
    let mut palette = Vec::with_capacity(colors * 3);
    let mut transparency = Vec::with_capacity(colors);
    for index in 0..colors {
        palette.extend_from_slice(&map[index * 4..index * 4 + 3]);
        if has_alpha {
            let alpha = alpha_sum[index]
                .checked_div(alpha_count[index])
                .map_or(255, |value| value as u8);
            transparency.push(alpha);
        }
    }

    stage("压缩像素", 0.75);
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, image.width(), image.height());
        encoder.set_color(png::ColorType::Indexed);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_palette(palette);
        if has_alpha {
            encoder.set_trns(transparency);
        }
        encoder.set_compression(png::Compression::High);
        encoder.set_filter(png::Filter::Adaptive);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("PNG 调色板写出失败：{error}"))?;
        writer
            .write_image_data(&indices)
            .map_err(|error| format!("PNG 数据写入失败：{error}"))?;
        writer
            .finish()
            .map_err(|error| format!("PNG 收尾失败：{error}"))?;
    }
    Ok(bytes)
}

fn flatten(image: &RgbaImage, background: Rgba<u8>) -> image::RgbImage {
    let mut output = image::RgbImage::new(image.width(), image.height());
    for (x, y, pixel) in image.enumerate_pixels() {
        let alpha = u32::from(pixel[3]);
        let mix = |channel: u8, base: u8| -> u8 {
            ((u32::from(channel) * alpha + u32::from(base) * (255 - alpha)) / 255) as u8
        };
        output.put_pixel(
            x,
            y,
            image::Rgb([
                mix(pixel[0], background[0]),
                mix(pixel[1], background[1]),
                mix(pixel[2], background[2]),
            ]),
        );
    }
    output
}

fn parse_color(value: &str) -> Result<Rgba<u8>, String> {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("颜色需要是 #RRGGBB".into());
    }
    let number = u32::from_str_radix(hex, 16).map_err(|_| "颜色无效")?;
    Ok(Rgba([
        ((number >> 16) & 255) as u8,
        ((number >> 8) & 255) as u8,
        (number & 255) as u8,
        255,
    ]))
}

fn preview_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    encode_png_small(&fit_long_edge(image, 960))
}

fn draw_watermark(image: &mut RgbaImage, edit: &Edit, mark: Option<&[u8]>) -> Result<(), String> {
    if !edit.watermark_image_id.trim().is_empty() && mark.is_none() {
        return Err("水印图片不在本次授权中".into());
    }
    let mut parts = Vec::new();
    if let Some(bytes) = mark {
        let edge = edit
            .font_size
            .saturating_mul(6)
            .clamp(32, image.width().max(image.height()).clamp(32, 1024));
        parts.push(mark_sprite(bytes, edge)?);
    }
    if !edit.watermark_text.trim().is_empty() {
        parts.push(render_text(
            &edit.watermark_text,
            edit.font_size,
            parse_color(&edit.watermark_color)?,
        )?);
    }
    if parts.is_empty() {
        return Err("明水印需要文字或一张已导入的图片".into());
    }
    let sprite = stack_sprites(&parts, 8);
    let rotated = if edit.watermark_mode == "tile" || edit.angle != 0 {
        rotate_sprite(&sprite, edit.angle as f32)
    } else {
        sprite
    };
    let alpha = edit.opacity.clamp(0, 100) as f32 / 100.0;
    match edit.watermark_mode.as_str() {
        "tile" => stamp_tile(image, &rotated, edit.gap.max(8), alpha),
        "center" => {
            let x = (image.width() as i32 - rotated.width() as i32) / 2;
            let y = (image.height() as i32 - rotated.height() as i32) / 2;
            stamp(image, &rotated, x, y, alpha);
        }
        _ => {
            let (x, y) = anchor_position(
                image.width(),
                image.height(),
                rotated.width(),
                rotated.height(),
                &edit.anchor,
                edit.margin,
            );
            stamp(image, &rotated, x, y, alpha);
        }
    }
    Ok(())
}

fn anchor_position(
    image_w: u32,
    image_h: u32,
    mark_w: u32,
    mark_h: u32,
    anchor: &str,
    margin: u32,
) -> (i32, i32) {
    let margin = margin as i32;
    let left = margin;
    let right = image_w as i32 - mark_w as i32 - margin;
    let center_x = (image_w as i32 - mark_w as i32) / 2;
    let top = margin;
    let bottom = image_h as i32 - mark_h as i32 - margin;
    let center_y = (image_h as i32 - mark_h as i32) / 2;
    match anchor {
        "nw" => (left, top),
        "n" => (center_x, top),
        "ne" => (right, top),
        "w" => (left, center_y),
        "center" => (center_x, center_y),
        "e" => (right, center_y),
        "sw" => (left, bottom),
        "s" => (center_x, bottom),
        _ => (right, bottom),
    }
}

fn mark_sprite(bytes: &[u8], max_edge: u32) -> Result<RgbaImage, String> {
    let inspected = inspect(bytes);
    if inspected.status != "ready" {
        return Err(inspected.message);
    }
    if inspected.animated || inspected.pages > 1 {
        return Err("水印图片需要是静态图".into());
    }
    let image = decode(bytes, inspected.kind, &Edit::default())?;
    let long = image.width().max(image.height()).max(1);
    if long <= max_edge {
        return Ok(image);
    }
    let scale = max_edge as f32 / long as f32;
    Ok(image::imageops::resize(
        &image,
        ((image.width() as f32) * scale).round().max(1.0) as u32,
        ((image.height() as f32) * scale).round().max(1.0) as u32,
        image::imageops::FilterType::Triangle,
    ))
}

fn stack_sprites(parts: &[RgbaImage], gap: u32) -> RgbaImage {
    if parts.len() == 1 {
        return parts[0].clone();
    }
    let width = parts
        .iter()
        .map(|part| part.width())
        .max()
        .unwrap_or(1)
        .max(1);
    let height = parts.iter().map(|part| part.height()).sum::<u32>()
        + gap.saturating_mul(parts.len() as u32 - 1);
    let mut canvas = RgbaImage::from_pixel(width, height.max(1), Rgba([0, 0, 0, 0]));
    let mut y = 0i32;
    for part in parts {
        let x = (width as i32 - part.width() as i32) / 2;
        stamp(&mut canvas, part, x, y, 1.0);
        y += part.height() as i32 + gap as i32;
    }
    canvas
}

fn stamp(image: &mut RgbaImage, sprite: &RgbaImage, origin_x: i32, origin_y: i32, opacity: f32) {
    for (x, y, pixel) in sprite.enumerate_pixels() {
        let dx = origin_x + x as i32;
        let dy = origin_y + y as i32;
        if dx < 0 || dy < 0 || dx >= image.width() as i32 || dy >= image.height() as i32 {
            continue;
        }
        let alpha = pixel[3] as f32 / 255.0 * opacity;
        if alpha <= 0.0 {
            continue;
        }
        let dest = image.get_pixel(dx as u32, dy as u32).0;
        let mix = |source: u8, current: u8| -> u8 {
            (source as f32 * alpha + current as f32 * (1.0 - alpha)).round() as u8
        };
        image.put_pixel(
            dx as u32,
            dy as u32,
            Rgba([
                mix(pixel[0], dest[0]),
                mix(pixel[1], dest[1]),
                mix(pixel[2], dest[2]),
                255,
            ]),
        );
    }
}

fn stamp_tile(image: &mut RgbaImage, sprite: &RgbaImage, gap: u32, opacity: f32) {
    let step_x = sprite.width() + gap;
    let step_y = sprite.height() + gap;
    if step_x == 0 || step_y == 0 {
        return;
    }
    let mut y = 0i32;
    while y < image.height() as i32 {
        let mut x = 0i32;
        while x < image.width() as i32 {
            stamp(image, sprite, x, y, opacity);
            x += step_x as i32;
        }
        y += step_y as i32;
    }
}

fn rotate_sprite(source: &RgbaImage, degrees: f32) -> RgbaImage {
    if degrees == 0.0 {
        return source.clone();
    }
    rotate_arbitrary(source, degrees)
}

fn render_text(text: &str, font_size: u32, color: Rgba<u8>) -> Result<RgbaImage, String> {
    let bytes = font_bytes()?;
    let font = swash::FontRef::from_index(&bytes, 0).ok_or("字体无法读取")?;
    let mut context = swash::scale::ScaleContext::new();
    let mut scaler = context
        .builder(font)
        .size(font_size as f32)
        .hint(true)
        .build();
    let metrics = font.metrics(&[]);
    let upem = f32::from(metrics.units_per_em.max(1));
    let advances = font
        .glyph_metrics(&[])
        .linear_scale(font_size as f32 / upem);
    let mut glyphs = Vec::new();
    let mut pen = 0i32;
    let mut drawn = false;
    for ch in text.chars() {
        let id = font.charmap().map(ch);
        if id == 0 {
            pen += font_size as i32 / 2;
            continue;
        }
        let advance = advances.advance_width(id).ceil().max(1.0) as i32;
        if let Some(image) =
            swash::scale::Render::new(&[swash::scale::Source::Outline]).render(&mut scaler, id)
        {
            drawn = true;
            glyphs.push((pen, image));
        }
        pen += advance;
    }
    if !drawn {
        return Err("找不到可绘制这些文字的字形".into());
    }
    let width = pen.max(1) as u32 + 4;
    let height = (font_size as f32 * 1.4).ceil() as u32 + 4;
    let baseline = font_size as i32 + 2;
    let mut canvas = RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 0]));
    for (origin, glyph) in glyphs {
        blit_mask(&mut canvas, origin, baseline, &glyph, color);
    }
    Ok(canvas)
}

fn blit_mask(
    canvas: &mut RgbaImage,
    origin: i32,
    baseline: i32,
    glyph: &swash::scale::image::Image,
    color: Rgba<u8>,
) {
    let base_x = origin + glyph.placement.left;
    let base_y = baseline - glyph.placement.top;
    for row in 0..glyph.placement.height {
        for column in 0..glyph.placement.width {
            let x = base_x + column as i32;
            let y = base_y + row as i32;
            if x < 0 || y < 0 || x >= canvas.width() as i32 || y >= canvas.height() as i32 {
                continue;
            }
            let coverage = glyph.data[(row * glyph.placement.width + column) as usize];
            if coverage == 0 {
                continue;
            }
            let dest = canvas.get_pixel(x as u32, y as u32).0;
            let alpha = u16::from(coverage);
            let mix = |source: u8, current: u8| -> u8 {
                ((u16::from(source) * alpha + u16::from(current) * (255 - alpha)) / 255) as u8
            };
            canvas.put_pixel(
                x as u32,
                y as u32,
                Rgba([
                    mix(color[0], dest[0]),
                    mix(color[1], dest[1]),
                    mix(color[2], dest[2]),
                    coverage.max(dest[3]),
                ]),
            );
        }
    }
}

fn font_bytes() -> Result<Arc<Vec<u8>>, String> {
    static CACHE: OnceLock<Arc<Vec<u8>>> = OnceLock::new();
    if let Some(cached) = CACHE.get() {
        return Ok(Arc::clone(cached));
    }
    let candidates = [
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyh.ttf",
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\simsun.ttc",
    ];
    for path in candidates {
        if let Ok(bytes) = std::fs::read(path) {
            if swash::FontRef::from_index(&bytes, 0).is_some() {
                let cached = Arc::new(bytes);
                let _ = CACHE.set(Arc::clone(&cached));
                return Ok(cached);
            }
        }
    }
    Err("找不到可绘制中文的字体".into())
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(512)];
    let text = String::from_utf8_lossy(sample).to_ascii_lowercase();
    text.contains("<svg")
}

fn ftyp_kind(bytes: &[u8]) -> Option<Kind> {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return None;
    }
    let mut saw_heic = false;
    let mut offset = 8;
    while offset + 4 <= bytes.len().min(64) {
        let brand = &bytes[offset..offset + 4];
        if brand == b"avif" || brand == b"avis" {
            return Some(Kind::Avif);
        }
        if matches!(
            brand,
            b"heic" | b"heix" | b"hevc" | b"heif" | b"mif1" | b"msf1"
        ) {
            saw_heic = true;
        }
        offset += 4;
    }
    saw_heic.then_some(Kind::Heic)
}

fn gif_frames(bytes: &[u8]) -> Result<u32, ()> {
    if bytes.len() < 13 || &bytes[..3] != b"GIF" {
        return Err(());
    }
    let mut index = 13;
    if bytes[10] & 0x80 != 0 {
        index += 3 * (1usize << ((bytes[10] & 7) + 1));
    }
    let mut frames = 0u32;
    while index < bytes.len() {
        match bytes[index] {
            0x3B => break,
            0x21 => {
                index += 2;
                index = skip_sub_blocks(bytes, index)?;
            }
            0x2C => {
                frames += 1;
                if index + 10 >= bytes.len() {
                    return Err(());
                }
                let packed = bytes[index + 9];
                index += 10;
                if packed & 0x80 != 0 {
                    index += 3 * (1usize << ((packed & 7) + 1));
                }
                index += 1;
                index = skip_sub_blocks(bytes, index)?;
            }
            _ => return Err(()),
        }
    }
    Ok(frames.max(1))
}

fn skip_sub_blocks(bytes: &[u8], mut index: usize) -> Result<usize, ()> {
    while index < bytes.len() {
        let size = bytes[index] as usize;
        index += 1 + size;
        if size == 0 {
            return Ok(index);
        }
    }
    Err(())
}

fn tiff_pages(bytes: &[u8]) -> u32 {
    if bytes.len() < 8 {
        return 1;
    }
    let little = bytes.starts_with(b"II*\0");
    let big = bytes.starts_with(b"MM\0*");
    if !little && !big {
        return 1;
    }
    let read_u16 = |offset: usize| -> Option<u16> {
        let pair = bytes.get(offset..offset + 2)?;
        Some(if little {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        })
    };
    let read_u32 = |offset: usize| -> Option<u32> {
        let quad = bytes.get(offset..offset + 4)?;
        Some(if little {
            u32::from_le_bytes([quad[0], quad[1], quad[2], quad[3]])
        } else {
            u32::from_be_bytes([quad[0], quad[1], quad[2], quad[3]])
        })
    };
    let mut offset = read_u32(4).unwrap_or(0) as usize;
    let mut pages = 0u32;
    for _ in 0..32 {
        if offset + 2 > bytes.len() {
            break;
        }
        let count = read_u16(offset).unwrap_or(0) as usize;
        pages += 1;
        let next = offset + 2 + count * 12;
        offset = read_u32(next).unwrap_or(0) as usize;
        if offset == 0 {
            break;
        }
    }
    pages.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_shows_the_encoded_pixels_instead_of_the_uncompressed_image() {
        let bytes = photo_png(64, 48);
        let result = process(
            &bytes,
            &Edit {
                quality: 20,
                keep_smaller: false,
                ..Edit::default()
            },
            Kind::Png,
            None,
        )
        .unwrap();
        let encoded = image::load_from_memory(&result.encoded).unwrap().to_rgba8();
        let preview = image::load_from_memory(&result.preview).unwrap().to_rgba8();
        assert_eq!(preview, encoded);
        assert_ne!(preview, image::load_from_memory(&bytes).unwrap().to_rgba8());
    }

    #[test]
    fn metadata_only_does_not_reencode_pixels() {
        let bytes = jpeg_bytes();
        let edit: Edit = serde_json::from_value(serde_json::json!({
            "metadataOnly": true, "metadataPolicy": "addGeneric", "author": "测试作者", "quality": 60, "keepSmaller": false
        })).unwrap();
        let result = process(&bytes, &edit, Kind::Jpeg, None).unwrap();
        assert_eq!(
            image::load_from_memory(&bytes).unwrap().to_rgba8(),
            image::load_from_memory(&result.encoded).unwrap().to_rgba8()
        );
    }

    #[test]
    fn target_is_checked_after_metadata_is_written() {
        let bytes = photo_png(16, 16);
        let edit = Edit {
            target_kb: 1,
            skip_if_below_target: true,
            metadata_policy: "addGeneric".into(),
            description: "说明".repeat(1000),
            ..Edit::default()
        };
        let result = process(&bytes, &edit, Kind::Png, None).unwrap();
        assert!(result.encoded.len() > 1024);
        assert!(result.below_target, "写入声明后超标不能仍然声称达标");
    }

    fn aigc_edit() -> MetaEdit {
        MetaEdit {
            policy: "addAigc".into(),
            author: String::new(),
            copyright: String::new(),
            description: String::new(),
            aigc_label: "1".into(),
            producer: String::new(),
            delete_fields: Vec::new(),
        }
    }

    #[test]
    fn reencoding_migrates_source_declarations_instead_of_losing_them() {
        let bytes = metadata::apply_metadata(&jpeg_bytes(), Kind::Jpeg, &aigc_edit()).unwrap();
        let source_packet = migration::extract(&bytes, Kind::Jpeg).xmp;
        assert!(!source_packet.is_empty());
        let result = process(
            &bytes,
            &Edit {
                keep_smaller: false,
                ..Edit::default()
            },
            Kind::Jpeg,
            None,
        )
        .unwrap();
        let out = migration::extract(&result.encoded, Kind::Jpeg);
        assert_eq!(out.xmp, source_packet, "重编码必须逐字节携带 XMP 声明");
        assert!(result.message.contains("已迁移并复检"));
        let aigc = metadata::read_evidence(&result.encoded)
            .aigc
            .expect("声明应可读回");
        assert!(aigc.produce_id.starts_with("chunjun-"));
    }

    #[test]
    fn webp_target_keeps_refusing_metadata_loss_until_explicitly_confirmed() {
        let bytes = metadata::apply_metadata(&jpeg_bytes(), Kind::Jpeg, &aigc_edit()).unwrap();
        let refused = process(
            &bytes,
            &Edit {
                keep_smaller: false,
                output_format: "webp".into(),
                ..Edit::default()
            },
            Kind::Jpeg,
            None,
        );
        let message = refused.unwrap_err();
        assert!(message.contains("无法承载"), "{message}");
        let confirmed = process(
            &bytes,
            &Edit {
                keep_smaller: false,
                output_format: "webp".into(),
                allow_metadata_loss: true,
                ..Edit::default()
            },
            Kind::Jpeg,
            None,
        )
        .unwrap();
        assert!(confirmed.message.contains("已按确认不保留"));
    }

    #[test]
    fn full_migration_moves_exif_icc_and_xmp_through_the_pipeline() {
        let bytes = crate::migration::fixtures::jpeg_with(
            Some(&crate::migration::fixtures::tiff_exif(6, 32, 24)),
            Some(&crate::migration::fixtures::fake_icc()),
            Some(&crate::migration::fixtures::known_xmp()),
        );
        let result = process(
            &bytes,
            &Edit {
                keep_smaller: false,
                output_format: "png".into(),
                ..Edit::default()
            },
            Kind::Jpeg,
            None,
        )
        .unwrap();
        // 方向 6 在解码时烘焙：像素已旋正为 24×32。
        assert_eq!((result.width, result.height), (24, 32));
        let out = migration::extract(&result.encoded, Kind::Png);
        let tiff = out.exif_tiff.expect("EXIF 应迁入 eXIf 块");
        assert_eq!(migration::exif_field_count(&tiff), 6);
        assert_eq!(out.icc_raw, Some(crate::migration::fixtures::fake_icc()));
        assert_eq!(out.xmp, vec![crate::migration::fixtures::known_xmp()]);
        assert!(result.message.contains("已迁移并复检"));
    }

    #[test]
    fn tiff_source_migrates_containers_through_the_pipeline() {
        use crate::migration::fixtures;
        let bytes = fixtures::tiff_source(
            6,
            Some(&fixtures::known_xmp()),
            Some(&fixtures::fake_icc()),
            8,
            false,
        );
        let result = process(
            &bytes,
            &Edit {
                output_format: "keep".into(),
                ..Edit::default()
            },
            Kind::Tiff,
            None,
        )
        .unwrap();
        // TIFF 源 keep 输出 PNG；方向 6 解码时烘焙为 24×32。
        assert_eq!(result.kind, Kind::Png);
        assert_eq!((result.width, result.height), (24, 32));
        let out = migration::extract(&result.encoded, Kind::Png);
        let tiff = out.exif_tiff.expect("IFD0 前缀应迁入 eXIf 块");
        assert_eq!(migration::orientation_of_tiff(&tiff), 1);
        assert!(tiff
            .windows(fixtures::VENDOR_MARK.len())
            .any(|w| w == fixtures::VENDOR_MARK));
        assert_eq!(out.icc_raw, Some(fixtures::fake_icc()));
        assert_eq!(out.xmp, vec![fixtures::known_xmp()]);
        assert!(result.message.contains("已迁移并复检"));
    }

    #[test]
    fn gif_source_carries_its_xmp_through_the_pipeline() {
        use crate::migration::fixtures;
        let bytes = fixtures::gif_with(Some(&fixtures::known_xmp()), false);
        let result = process(
            &bytes,
            &Edit {
                output_format: "keep".into(),
                ..Edit::default()
            },
            Kind::Gif,
            None,
        )
        .unwrap();
        assert_eq!(result.kind, Kind::Png);
        let out = migration::extract(&result.encoded, Kind::Png);
        assert_eq!(out.xmp, vec![fixtures::known_xmp()]);
        assert!(result.message.contains("XMP"));
    }

    #[test]
    fn tiff_page_selection_decodes_the_chosen_page() {
        use crate::migration::fixtures;
        let bytes = fixtures::tiff_two_pages(0x11, 0xE7);
        assert_eq!(tiff_pages(&bytes), 2);
        // 第 1 页
        let page1 = decode_frame(&bytes, Kind::Tiff, 1).unwrap();
        assert_eq!(page1.dimensions(), (16, 12));
        assert_eq!(page1.get_pixel(3, 4)[0], 0x11);
        // 第 2 页：不同填充，说明真的翻了目录。
        let page2 = decode_frame(&bytes, Kind::Tiff, 2).unwrap();
        assert_eq!(page2.get_pixel(3, 4)[0], 0xE7);
        // 超出页数：明确报错，不静默回退首页。
        assert!(decode_frame(&bytes, Kind::Tiff, 3).is_err());
    }

    /// 两页 TIFF：第 1 页 IFD0 带 Exif 子 IFD 与 XMP，第 2 页纯像素。
    fn two_page_tiff_with_exif() -> Vec<u8> {
        use crate::migration::fixtures;
        let xmp = fixtures::known_xmp();
        let mut bytes = fixtures::tiff_source(1, Some(&xmp), None, 8, false);
        let (width, height) = (16u32, 12u32);
        let strip_len = (width * height) as usize;
        // 单页夹具的像素条带在文件末尾；在其后追加第 2 页 IFD，并把第 1 页
        // IFD0 的 next-IFD 指过去。
        let ifd0 = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let count = u16::from_le_bytes(bytes[ifd0..ifd0 + 2].try_into().unwrap()) as usize;
        let page2_ifd = bytes.len();
        let page2_strip = page2_ifd + 2 + 9 * 12 + 4;
        let next_at = ifd0 + 2 + count * 12;
        bytes[next_at..next_at + 4].copy_from_slice(&(page2_ifd as u32).to_le_bytes());
        let entry = |tag: u16, kind: u16, cnt: u32, value: u32| -> [u8; 12] {
            let mut entry = [0u8; 12];
            entry[0..2].copy_from_slice(&tag.to_le_bytes());
            entry[2..4].copy_from_slice(&kind.to_le_bytes());
            entry[4..8].copy_from_slice(&cnt.to_le_bytes());
            entry[8..12].copy_from_slice(&value.to_le_bytes());
            entry
        };
        let mut page2 = Vec::new();
        page2.extend_from_slice(&9u16.to_le_bytes());
        for item in [
            entry(0x0100, 4, 1, width),
            entry(0x0101, 4, 1, height),
            entry(0x0102, 3, 1, 8),
            entry(0x0103, 3, 1, 1),
            entry(0x0106, 3, 1, 1),
            entry(0x0111, 4, 1, page2_strip as u32),
            entry(0x0115, 3, 1, 1),
            entry(0x0116, 4, 1, height),
            entry(0x0117, 4, 1, strip_len as u32),
        ] {
            page2.extend_from_slice(&item);
        }
        page2.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&page2);
        bytes.extend(std::iter::repeat_n(0x3Cu8, strip_len));
        bytes
    }

    #[test]
    fn multi_page_tiff_foreign_page_metadata_needs_consent() {
        use crate::migration::fixtures;
        // 单页 TIFF 选第 2 页：页数越界直接报错。
        let single = fixtures::tiff_source(1, Some(&fixtures::known_xmp()), None, 8, false);
        let error = process(
            &single,
            &Edit {
                frame_index: 2,
                ..Edit::default()
            },
            Kind::Tiff,
            None,
        )
        .unwrap_err();
        assert!(error.contains("超出范围"), "{error}");
        // 双页 TIFF 选第 2 页：第 1 页的 EXIF 不能张冠李戴，须确认丢弃。
        let rich = two_page_tiff_with_exif();
        let refused = process(
            &rich,
            &Edit {
                frame_index: 2,
                ..Edit::default()
            },
            Kind::Tiff,
            None,
        )
        .unwrap_err();
        assert!(refused.contains("所选页之外"), "{refused}");
        let confirmed = process(
            &rich,
            &Edit {
                frame_index: 2,
                allow_metadata_loss: true,
                ..Edit::default()
            },
            Kind::Tiff,
            None,
        )
        .unwrap();
        assert!(
            confirmed.message.contains("已按确认不保留"),
            "{}",
            confirmed.message
        );
        let out = migration::extract(&confirmed.encoded, Kind::Png);
        assert!(
            out.exif_tiff.is_none(),
            "第 1 页的 EXIF 不能挂到第 2 页副本"
        );
        assert_eq!(out.xmp.len(), 1, "文档级 XMP 仍然迁移");
    }

    #[test]
    fn frame_budget_stops_runaway_animations() {
        let frames = (0..4).map(|index| {
            Ok(image::Frame::new(image::RgbaImage::from_pixel(
                64,
                64,
                image::Rgba([index as u8, 0, 0, 255]),
            )))
        });
        // 每帧 4096 像素，预算 8000：跳到第 4 帧必然超预算。
        let error = nth_frame("GIF", frames, 4, 8000).unwrap_err();
        assert!(error.contains("预算"), "{error}");
        // 预算内：返回目标帧本身。
        let frames = (0..2).map(|index| {
            Ok(image::Frame::new(image::RgbaImage::from_pixel(
                8,
                8,
                image::Rgba([index as u8, 9, 9, 255]),
            )))
        });
        let frame = nth_frame("GIF", frames, 2, 1_000_000).unwrap();
        assert_eq!(frame.get_pixel(0, 0)[0], 1);
    }

    #[test]
    fn scaling_above_the_pixel_budget_is_refused() {
        let edit = Edit {
            scale_mode: "percent".into(),
            percent: 400,
            allow_upscale: true,
            ..Edit::default()
        };
        let image = RgbaImage::from_pixel(4000, 3500, image::Rgba([1, 2, 3, 255]));
        // 400% × 1400 万像素 = 2.24 亿像素，必须拒绝而不是试图分配。
        let error = scale_image(image, &edit).unwrap_err();
        assert!(error.contains("4000 万像素上限"), "{error}");
    }

    #[test]
    fn quality_floor_does_not_reject_quality_mode() {
        let edit = Edit {
            quality: 10,
            target_kb: 0,
            ..Edit::default()
        };
        assert!(edit.validate().is_ok());
    }

    #[test]
    fn apng_is_not_silently_flattened_to_a_still_png() {
        let bytes = photo_png(16, 16);
        let mut animated = bytes[..33].to_vec();
        let mut control = 8u32.to_be_bytes().to_vec();
        control.extend_from_slice(b"acTL");
        control.extend_from_slice(&2u32.to_be_bytes());
        control.extend_from_slice(&0u32.to_be_bytes());
        let crc = crc32fast::hash(&control[4..]);
        control.extend_from_slice(&crc.to_be_bytes());
        animated.extend(control);
        animated.extend_from_slice(&bytes[33..]);
        assert_eq!(inspect(&animated).status, "unsupported");
        assert!(process(&animated, &Edit::default(), Kind::Png, None).is_err());
    }
    use image::{ImageBuffer, Rgb};

    fn jpeg_bytes() -> Vec<u8> {
        let image: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(32, 24, |x, y| Rgb([(x * 8) as u8, (y * 10) as u8, 80]));
        let mut bytes = Vec::new();
        DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Jpeg)
            .unwrap();
        bytes
    }

    #[test]
    fn jpeg_roundtrip_is_smaller_or_keeps_source_when_larger() {
        let original = jpeg_bytes();
        let edit = Edit {
            quality: 60,
            keep_smaller: true,
            output_format: "jpeg".into(),
            ..Edit::default()
        };
        let processed = process(&original, &edit, Kind::Jpeg, None).unwrap();
        assert!(processed.encoded.len() <= original.len());
        let decoded = image::load_from_memory(&processed.encoded).unwrap();
        assert!(decoded.width() >= 30);
    }

    #[test]
    fn watermark_changes_pixels_or_explains_missing_font() {
        let mut image = RgbaImage::from_pixel(180, 80, Rgba([255, 255, 255, 255]));
        let edit = Edit {
            watermark: true,
            watermark_text: "仅供办理测试使用，他用无效".into(),
            watermark_mode: "single".into(),
            opacity: 100,
            font_size: 24,
            ..Edit::default()
        };
        match draw_watermark(&mut image, &edit, None) {
            Ok(()) => assert!(image.pixels().any(|pixel| pixel[0] < 250)),
            Err(error) => assert!(error.contains("字体") || error.contains("字形")),
        }
    }

    #[test]
    fn animated_gif_without_a_choice_is_rejected() {
        let frame = image::RgbaImage::from_pixel(4, 4, Rgba([1, 2, 3, 255]));
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(frame)
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Gif)
            .unwrap();
        // A one-frame GIF is a still image and can be exported.
        let processed = process(
            &bytes,
            &Edit {
                output_format: "png".into(),
                ..Edit::default()
            },
            Kind::Gif,
            None,
        );
        assert!(processed.is_ok());
    }

    #[test]
    fn image_watermark_changes_pixels_without_text() {
        let base = RgbaImage::from_pixel(40, 40, Rgba([255, 255, 255, 255]));
        let mut source = Vec::new();
        DynamicImage::ImageRgba8(base)
            .write_to(&mut Cursor::new(&mut source), image::ImageFormat::Png)
            .unwrap();
        let mark = RgbaImage::from_pixel(8, 8, Rgba([200, 0, 0, 255]));
        let mut mark_bytes = Vec::new();
        DynamicImage::ImageRgba8(mark)
            .write_to(&mut Cursor::new(&mut mark_bytes), image::ImageFormat::Png)
            .unwrap();
        let processed = process(
            &source,
            &Edit {
                watermark: true,
                watermark_image_id: "mark".into(),
                watermark_mode: "center".into(),
                angle: 0,
                opacity: 100,
                output_format: "png".into(),
                ..Edit::default()
            },
            Kind::Png,
            Some(&mark_bytes),
        )
        .unwrap();
        let decoded = image::load_from_memory(&processed.encoded)
            .unwrap()
            .to_rgba8();
        assert!(decoded
            .pixels()
            .any(|pixel| pixel[0] > 150 && pixel[1] < 40));
    }

    #[test]
    fn stages_advance_monotonically_and_finish_near_complete() {
        let original = photo_png(320, 240);
        let seen = std::cell::RefCell::new(Vec::new());
        let processed = process_with_stage(
            &original,
            &Edit::default(),
            Kind::Png,
            None,
            &|name, fraction| {
                seen.borrow_mut().push((name.to_string(), fraction));
            },
        )
        .unwrap();
        assert!(!processed.encoded.is_empty());
        let stages = seen.into_inner();
        assert!(
            stages.len() >= 4,
            "处理过程至少应报出解码、编码、校验几个阶段：{stages:?}"
        );
        assert!(
            stages.windows(2).all(|pair| pair[0].1 <= pair[1].1),
            "阶段进度不能倒退：{stages:?}"
        );
        let last = stages.last().map(|pair| pair.1).unwrap_or(0.0);
        assert!(last >= 0.9, "结束时进度应接近满格，实际 {last}");
    }

    #[test]
    fn out_of_range_crop_clamps_instead_of_failing() {
        let original = jpeg_bytes();
        let edit = Edit {
            use_crop: true,
            crop_x: 20,
            crop_y: 10,
            crop_w: 100,
            crop_h: 100,
            output_format: "png".into(),
            ..Edit::default()
        };
        let processed = process(&original, &edit, Kind::Jpeg, None).unwrap();
        let decoded = image::load_from_memory(&processed.encoded).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (12, 14));
    }

    fn photo_png(width: u32, height: u32) -> Vec<u8> {
        let image = RgbaImage::from_fn(width, height, |x, y| {
            let fx = x as f32 / width as f32;
            let fy = y as f32 / height as f32;
            let wave = ((fx * 9.0).sin() + (fy * 7.0).cos()) * 20.0;
            Rgba([
                (40.0 + 180.0 * fx + wave).clamp(0.0, 255.0) as u8,
                (30.0 + 160.0 * fy + wave).clamp(0.0, 255.0) as u8,
                (90.0 + 120.0 * (fx * fy).sqrt()).clamp(0.0, 255.0) as u8,
                255,
            ])
        });
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(image)
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn png_lossy_mode_really_shrinks_instead_of_re_encoding_losslessly() {
        let original = photo_png(320, 240);
        let edit = Edit {
            quality: 82,
            png_lossy: true,
            output_format: "keep".into(),
            ..Edit::default()
        };
        let processed = process(&original, &edit, Kind::Png, None).unwrap();
        assert!(
            processed.encoded.len() * 10 < original.len() * 7,
            "调色板压缩应有肉眼可见的收益：{} -> {}",
            original.len(),
            processed.encoded.len()
        );
        let decoded = image::load_from_memory(&processed.encoded).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (320, 240));
    }

    #[test]
    fn thumb_fits_the_long_edge_and_is_a_real_png() {
        let original = photo_png(320, 240);
        let encoded = thumb_png_base64(&original, Kind::Png, 96).unwrap();
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            encoded.as_bytes(),
        )
        .unwrap();
        let thumb = image::load_from_memory(&bytes).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (96, 72));
    }

    #[test]
    fn png_lossless_mode_keeps_every_pixel() {
        let original = photo_png(64, 48);
        let edit = Edit {
            quality: 82,
            png_lossy: false,
            output_format: "keep".into(),
            keep_smaller: false,
            ..Edit::default()
        };
        let processed = process(&original, &edit, Kind::Png, None).unwrap();
        let before = image::load_from_memory(&original).unwrap().to_rgba8();
        let after = image::load_from_memory(&processed.encoded)
            .unwrap()
            .to_rgba8();
        assert_eq!(before.as_raw(), after.as_raw());
    }

    #[test]
    fn png_palette_keeps_transparency() {
        let image = RgbaImage::from_fn(32, 32, |x, _| {
            if x < 16 {
                Rgba([200, 20, 20, 255])
            } else {
                Rgba([0, 0, 0, 0])
            }
        });
        let bytes = encode_png_palette(&image, 82, &|_, _| {}).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(decoded.get_pixel(4, 4)[3], 255);
        assert_eq!(decoded.get_pixel(28, 4)[3], 0);
    }
}
