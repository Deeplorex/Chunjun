//! 重编码时的元数据迁移：把源文件的 EXIF/ICC/XMP 与 PNG 文本、色彩块逐字节搬进
//! 新容器，只对 EXIF 的方向与尺寸条目做定点修正；迁移后从输出字节重新提取复检。
//! 不解析重组字段，未知字段随载荷原样保留，避免任何未理解的字节被丢弃。

use std::io::{Read as _, Write as _};

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;

use crate::metadata::png_chunk;
use crate::model::Kind;

const EXIF_HEADER: &[u8] = b"Exif\0\0";
const ICC_MARKER: &[u8] = b"ICC_PROFILE\0";
const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
/// ExtendedXMP 的 APP2 段签名（34 字符 + 结尾 NUL）。
const XMP_EXT_SIGNATURE: &[u8] = b"http://ns.adobe.com/xmp/extension/\0";
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const PNG_XMP_KEYWORD: &[u8] = b"XML:com.adobe.xmp";
const GIF_XMP_MAGIC: &[u8] = b"XMP DataXMP";
/// JPEG APPn 段内最大载荷（段长字段含自身 2 字节）。
const JPEG_SEGMENT_MAX: usize = u16::MAX as usize - 2;
/// 单个 APP2 ICC 段去掉 ICC_PROFILE\0 与两字节序号后的最大档案分片。
const ICC_SEGMENT_MAX: usize = JPEG_SEGMENT_MAX - ICC_MARKER.len() - 2;

/// 从源文件提取的可迁移容器。载荷保持原始字节；结构异常以标志记录，不静默丢弃。
#[derive(Debug, Clone, Default)]
pub struct SourceMetadata {
    /// 完整 EXIF TIFF 载荷（不含 Exif\0\0 头；PNG 源取自 eXIf 块，WebP 源去掉可选前缀）。
    pub exif_tiff: Option<Vec<u8>>,
    /// 解压后的 ICC 档案字节（PNG 源的 iCCP 已解压）。
    pub icc_raw: Option<Vec<u8>>,
    /// PNG 源的 iCCP 整块字节（含 CRC）；PNG 目标逐字节复用，避免重压缩。
    pub icc_png_chunk: Option<Vec<u8>>,
    /// 每份 XMP 包的原始字节（xpacket，不含容器头）。
    pub xmp: Vec<Vec<u8>>,
    /// PNG 文本与色彩块的整块字节，PNG 目标逐字节复用。
    pub png_chunks: Vec<Vec<u8>>,
    pub c2pa_clue: bool,
    /// 出现第二份 EXIF 段；无法安全合并，只能经用户确认后丢弃。
    pub duplicate_exif: bool,
    /// ICC 段序号不完整，拼不出完整档案。
    pub icc_broken: bool,
    /// ExtendedXMP 或 GIF XMP 子块重组失败（MD5/长度/终止符不符）。
    pub xmp_broken: bool,
    /// EXIF 容器无法按本版规则解析（如 BigTIFF 或越界 IFD）。
    pub exif_unreadable: bool,
    /// BMP V5 头声明 ICC 档案在外部文件里，副本无法承载。
    pub icc_linked: bool,
    /// TIFF 的元数据区与像素数据交错，整块前缀会夹带像素字节。
    pub tiff_layout_unsafe: bool,
    /// 多页 TIFF 导出的是第 2 页及以后：EXIF/ICC 记录在第 1 页 IFD0，不属于所选页。
    pub tiff_foreign_page: bool,
}

impl SourceMetadata {
    /// 除 C2PA 线索外是否存在可迁移内容（C2PA 重编码必然失效，不算可迁移项）。
    pub fn has_carriable(&self) -> bool {
        self.exif_tiff.is_some()
            || self.icc_raw.is_some()
            || self.icc_png_chunk.is_some()
            || !self.xmp.is_empty()
            || !self.png_chunks.is_empty()
            || self.duplicate_exif
            || self.icc_broken
            || self.xmp_broken
            || self.exif_unreadable
            || self.icc_linked
            || self.tiff_layout_unsafe
            || self.tiff_foreign_page
    }
}

/// 迁移支持的容器嗅探；其余格式视为没有可提取载荷。
pub(crate) fn sniff_kind(bytes: &[u8]) -> Kind {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        Kind::Jpeg
    } else if bytes.starts_with(PNG_SIGNATURE) {
        Kind::Png
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Kind::Webp
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Kind::Gif
    } else if bytes.starts_with(b"BM") {
        Kind::Bmp
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Kind::Tiff
    } else if looks_like_svg(bytes) {
        Kind::Svg
    } else {
        Kind::Unknown
    }
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(512)];
    String::from_utf8_lossy(sample)
        .to_ascii_lowercase()
        .contains("<svg")
}

pub fn extract(bytes: &[u8], kind: Kind) -> SourceMetadata {
    let mut meta = SourceMetadata {
        c2pa_clue: bytes.windows(4).any(|window| window == b"c2pa"),
        ..SourceMetadata::default()
    };
    match kind {
        Kind::Jpeg => extract_jpeg(bytes, &mut meta),
        Kind::Png => extract_png(bytes, &mut meta),
        Kind::Webp => extract_webp(bytes, &mut meta),
        Kind::Gif => extract_gif(bytes, &mut meta),
        Kind::Tiff => extract_tiff(bytes, &mut meta),
        Kind::Svg => extract_svg(bytes, &mut meta),
        Kind::Bmp => extract_bmp(bytes, &mut meta),
        _ => {}
    }
    meta
}

fn extract_jpeg(bytes: &[u8], meta: &mut SourceMetadata) {
    let mut index = 2usize;
    let mut icc_parts: Vec<(u8, u8, &[u8])> = Vec::new();
    let mut primary_xmp: Vec<Vec<u8>> = Vec::new();
    let mut extended: Vec<(&[u8], u32, u32, &[u8])> = Vec::new();
    while index + 4 <= bytes.len() && bytes[index] == 0xFF {
        let marker = bytes[index + 1];
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        if marker == 0x00 || (0xD0..=0xD8).contains(&marker) {
            index += 2;
            continue;
        }
        let size = u16::from_be_bytes([bytes[index + 2], bytes[index + 3]]) as usize;
        if size < 2 {
            break;
        }
        let next = index + 2 + size;
        if next > bytes.len() {
            break;
        }
        let data = &bytes[index + 4..next];
        if marker == 0xE1 && data.starts_with(EXIF_HEADER) {
            if meta.exif_tiff.is_none() {
                meta.exif_tiff = Some(data[EXIF_HEADER.len()..].to_vec());
            } else {
                meta.duplicate_exif = true;
            }
        } else if marker == 0xE2
            && data.starts_with(ICC_MARKER)
            && data.len() > ICC_MARKER.len() + 2
        {
            let rest = &data[ICC_MARKER.len()..];
            icc_parts.push((rest[0], rest[1], &rest[2..]));
        } else if marker == 0xE1 && data.starts_with(XMP_HEADER) {
            primary_xmp.push(data[XMP_HEADER.len()..].to_vec());
        } else if matches!(marker, 0xE1 | 0xE2)
            && data.len() > XMP_EXT_SIGNATURE.len() + 40
            && data.starts_with(XMP_EXT_SIGNATURE)
        {
            // ExtendedXMP 分片：签名 + 32 字节大写十六进制 MD5 + 4 字节全长 +
            // 4 字节片偏移（数值大端）。Adobe 写在 APP1，个别实现用 APP2，都接受。
            let rest = &data[XMP_EXT_SIGNATURE.len()..];
            let digest = &rest[..32];
            let total = u32::from_be_bytes(rest[32..36].try_into().unwrap());
            let offset = u32::from_be_bytes(rest[36..40].try_into().unwrap());
            extended.push((digest, total, offset, &rest[40..]));
        }
        index = next;
    }
    if !icc_parts.is_empty() {
        let total = icc_parts[0].1;
        icc_parts.sort_by_key(|(seq, _, _)| *seq);
        let sequential = icc_parts
            .iter()
            .enumerate()
            .all(|(position, (seq, part_total, _))| {
                *seq as usize == position + 1 && *part_total == total
            });
        if sequential && icc_parts.len() == total as usize {
            let mut profile = Vec::new();
            for (_, _, part) in &icc_parts {
                profile.extend_from_slice(part);
            }
            meta.icc_raw = Some(profile);
        } else {
            meta.icc_broken = true;
        }
    }
    match reassemble_extended_xmp(&extended) {
        Some(packet) => {
            // 扩展分片存在时 APP1 里只是占位包，读完整重组结果。
            meta.xmp.push(packet);
        }
        None if !extended.is_empty() => meta.xmp_broken = true,
        None => meta.xmp.extend(primary_xmp),
    }
}

/// 把 ExtendedXMP 分片按偏移拼回完整包；MD5 或覆盖范围不符返回 None，不静默取半截。
fn reassemble_extended_xmp(extended: &[(&[u8], u32, u32, &[u8])]) -> Option<Vec<u8>> {
    let (digest, total, _, _) = extended.first()?;
    let total = *total as usize;
    let expected_digest = digest.to_ascii_uppercase();
    if extended
        .iter()
        .any(|(other, other_total, _, _)| *other != *digest || *other_total as usize != total)
    {
        return None;
    }
    let mut assembled = vec![0u8; total];
    let mut covered = vec![false; total];
    for (_, _, offset, chunk) in extended {
        let start = *offset as usize;
        let end = start.checked_add(chunk.len())?;
        if end > total || covered[start..end].iter().any(|flag| *flag) {
            return None;
        }
        assembled[start..end].copy_from_slice(chunk);
        for flag in &mut covered[start..end] {
            *flag = true;
        }
    }
    if covered.iter().any(|flag| !*flag) || md5_hex(&assembled)[..] != expected_digest[..] {
        return None;
    }
    Some(assembled)
}

/// MD5 摘要的大写十六进制串，与 ExtendedXMP 的 GUID 字段（32 字节 A–F）比对。
fn md5_hex(data: &[u8]) -> [u8; 32] {
    let digest = md5(data);
    let mut text = [0u8; 32];
    for (index, byte) in digest.iter().enumerate() {
        text[index * 2] = b"0123456789ABCDEF"[(*byte >> 4) as usize];
        text[index * 2 + 1] = b"0123456789ABCDEF"[(*byte & 0x0F) as usize];
    }
    text
}

/// RFC 1321 MD5，仅用于 ExtendedXMP 重组后的完整性校验，不做任何安全用途。
fn md5(data: &[u8]) -> [u8; 16] {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];
    let mut a0: u32 = 0x6745_2301;
    let mut b0: u32 = 0xefcd_ab89;
    let mut c0: u32 = 0x98ba_dcfe;
    let mut d0: u32 = 0x1032_5476;
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_le_bytes());
    let (blocks, _) = message.as_chunks::<64>();
    for block in blocks {
        let mut words = [0u32; 16];
        for (index, word) in words.iter_mut().enumerate() {
            *word = u32::from_le_bytes(block[index * 4..index * 4 + 4].try_into().unwrap());
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for index in 0..64 {
            let (f, g) = match index / 16 {
                0 => ((b & c) | (!b & d), index),
                1 => ((d & b) | (!d & c), (5 * index + 1) % 16),
                2 => (b ^ c ^ d, (3 * index + 5) % 16),
                _ => (c ^ (b | !d), (7 * index) % 16),
            };
            let temp = d;
            d = c;
            c = b;
            let sum = a
                .wrapping_add(f)
                .wrapping_add(K[index])
                .wrapping_add(words[g]);
            b = b.wrapping_add(sum.rotate_left(S[index]));
            a = temp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut digest = [0u8; 16];
    digest[..4].copy_from_slice(&a0.to_le_bytes());
    digest[4..8].copy_from_slice(&b0.to_le_bytes());
    digest[8..12].copy_from_slice(&c0.to_le_bytes());
    digest[12..].copy_from_slice(&d0.to_le_bytes());
    digest
}

fn extract_png(bytes: &[u8], meta: &mut SourceMetadata) {
    let Some(chunks) = png_chunks(bytes) else {
        return;
    };
    for (kind, data, whole) in chunks {
        match kind {
            b"eXIf" => {
                if meta.exif_tiff.is_none() {
                    meta.exif_tiff = Some(data.to_vec());
                } else {
                    meta.duplicate_exif = true;
                }
            }
            b"iCCP" => match decompress_iccp(data) {
                Some(profile) => {
                    meta.icc_raw = Some(profile);
                    meta.icc_png_chunk = Some(whole.to_vec());
                }
                None => meta.icc_broken = true,
            },
            b"iTXt" => {
                if let Some(packet) = png_itext_payload(data) {
                    meta.xmp.push(packet);
                } else {
                    meta.png_chunks.push(whole.to_vec());
                }
            }
            b"tEXt" | b"zTXt" | b"gAMA" | b"cHRM" | b"sRGB" | b"cICP" => {
                meta.png_chunks.push(whole.to_vec());
            }
            _ => {}
        }
    }
}

fn extract_webp(bytes: &[u8], meta: &mut SourceMetadata) {
    let mut index = 12usize;
    while index + 8 <= bytes.len() {
        let fourcc = &bytes[index..index + 4];
        let size = u32::from_le_bytes(bytes[index + 4..index + 8].try_into().unwrap()) as usize;
        let start = index + 8;
        let Some(end) = start.checked_add(size) else {
            break;
        };
        if end > bytes.len() {
            break;
        }
        let data = &bytes[start..end];
        match fourcc {
            b"EXIF" => {
                let payload = if data.starts_with(EXIF_HEADER) {
                    &data[EXIF_HEADER.len()..]
                } else {
                    data
                };
                if meta.exif_tiff.is_none() {
                    meta.exif_tiff = Some(payload.to_vec());
                } else {
                    meta.duplicate_exif = true;
                }
            }
            b"ICCP" => meta.icc_raw = Some(data.to_vec()),
            b"XMP " => meta.xmp.push(data.to_vec()),
            _ => {}
        }
        index = end + (size & 1);
    }
}

fn find_bytes(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from >= haystack.len() || needle.is_empty() || haystack.len() - from < needle.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|position| position + from)
}

/// GIF 的 XMP 应用扩展块：`21 FF 0B "XMP DataXMP"` 后跟 255 字节子块序列，
/// 以 0 结束。载荷是全部子块的精确拼接；截断按损坏上报。
fn extract_gif(bytes: &[u8], meta: &mut SourceMetadata) {
    let mut search = 0usize;
    while let Some(found) = find_bytes(bytes, search, b"\x21\xFF\x0B") {
        if bytes.get(found + 3..found + 14) != Some(GIF_XMP_MAGIC) {
            search = found + 3;
            continue;
        }
        let mut index = found + 14;
        let mut packet = Vec::new();
        let mut closed = false;
        while index < bytes.len() {
            let length = bytes[index] as usize;
            if length == 0 {
                closed = true;
                break;
            }
            let Some(end) = index.checked_add(1).and_then(|at| at.checked_add(length)) else {
                break;
            };
            if end > bytes.len() {
                break;
            }
            packet.extend_from_slice(&bytes[index + 1..end]);
            index = end;
        }
        if closed && packet.starts_with(b"<?xpacket") {
            meta.xmp.push(packet);
        } else {
            meta.xmp_broken = true;
        }
        search = index.max(found + 14);
    }
}

/// SVG 的 XMP 以 xpacket 文本嵌在文档里；只提取完整的 `<?xpacket … ?>` 区间。
fn extract_svg(bytes: &[u8], meta: &mut SourceMetadata) {
    let mut search = 0usize;
    while let Some(found) = find_bytes(bytes, search, b"<?xpacket") {
        let Some(end_marker) = find_bytes(bytes, found, b"<?xpacket end=") else {
            meta.xmp_broken = true;
            break;
        };
        let Some(close) = find_bytes(bytes, end_marker, b"?>") else {
            meta.xmp_broken = true;
            break;
        };
        let end = close + 2;
        meta.xmp.push(bytes[found..end].to_vec());
        search = end;
    }
}

/// BMP：仅 V5 头内嵌（PROFILE_EMBEDDED）的 ICC 档案可迁移；外链（PROFILE_LINKED）
/// 指向外部文件，副本无法承载，登记为不可承载。偏移按规范从 DIB 头起点算。
fn extract_bmp(bytes: &[u8], meta: &mut SourceMetadata) {
    const DIB: usize = 14;
    let Some(header_size) = bytes
        .get(DIB..DIB + 4)
        .map(|slice| u32::from_le_bytes(slice.try_into().unwrap()))
    else {
        return;
    };
    if header_size < 124 || bytes.len() < DIB + 124 {
        return; // V4 及更早的头没有嵌入 ICC 的字段，无可提取内容。
    }
    let cs_type = &bytes[DIB + 56..DIB + 60];
    if cs_type == b"LINK" {
        meta.icc_linked = true;
        return;
    }
    if cs_type != b"MBED" {
        return;
    }
    let profile_offset =
        u32::from_le_bytes(bytes[DIB + 112..DIB + 116].try_into().unwrap()) as usize;
    let profile_size = u32::from_le_bytes(bytes[DIB + 116..DIB + 120].try_into().unwrap()) as usize;
    let Some(start) = DIB.checked_add(profile_offset) else {
        meta.icc_broken = true;
        return;
    };
    let Some(end) = start.checked_add(profile_size) else {
        meta.icc_broken = true;
        return;
    };
    if profile_size == 0 || end > bytes.len() {
        meta.icc_broken = true;
        return;
    }
    meta.icc_raw = Some(bytes[start..end].to_vec());
}

fn tiff_type_size(field_type: u16) -> Option<u64> {
    match field_type {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

/// 把条目值按 SHORT/LONG 数组读成 u32，用于条带偏移与长度的配对。
fn u32_values(value: &[u8], field_type: u16, big_endian: bool) -> Option<Vec<u32>> {
    let read_short = |chunk: &[u8; 2]| -> Option<u32> {
        Some(if big_endian {
            u16::from_be_bytes(*chunk) as u32
        } else {
            u16::from_le_bytes(*chunk) as u32
        })
    };
    let read_long = |chunk: &[u8; 4]| -> Option<u32> {
        Some(if big_endian {
            u32::from_be_bytes(*chunk)
        } else {
            u32::from_le_bytes(*chunk)
        })
    };
    match field_type {
        3 => value.as_chunks::<2>().0.iter().map(read_short).collect(),
        4 => value.as_chunks::<4>().0.iter().map(read_long).collect(),
        _ => None,
    }
}

/// 从源文件摘出的 IFD 条目：值字节原样拷贝，重排时只改写偏移与目录结构。
struct CopiedEntry {
    tag: u16,
    field_type: u16,
    count: u32,
    value: Vec<u8>,
    /// 重排目标里的子 IFD 序号（Exif/GPS 指针条目）。
    sub: Option<usize>,
}

struct CopiedIfd {
    entries: Vec<CopiedEntry>,
}

struct TiffWalk<'a> {
    bytes: &'a [u8],
    big_endian: bool,
    visited: Vec<usize>,
    /// 文件头 + IFD 链 + 越界值区覆盖到的最大结尾；即整块前缀载荷的长度。
    extent: usize,
    failed: bool,
    xmp: Option<Vec<u8>>,
    icc: Option<Vec<u8>>,
    strip_offsets: Vec<u32>,
    strip_counts: Vec<u32>,
    /// IFD0 在前、子 IFD 随后的条目拷贝，交错布局重排时使用。
    copied: Vec<CopiedIfd>,
    /// 任一层级出现 MakerNote：内部常用绝对偏移，重排后可能失效。
    maker_note: bool,
}

impl TiffWalk<'_> {
    fn mark(&mut self, end: usize) {
        if end > self.bytes.len() {
            self.failed = true;
        } else if end > self.extent {
            self.extent = end;
        }
    }

    /// 走一遍 IFD 及其 Exif/GPS 子 IFD：统计范围、摘出可分离载荷与条目拷贝，
    /// 不改源字节。返回本 IFD 在 copied 里的序号；失败返回 None。
    fn walk(&mut self, offset: usize, root: bool, depth: usize) -> Option<usize> {
        if self.failed {
            return None;
        }
        if depth > 4 || self.visited.contains(&offset) {
            self.failed = true;
            return None;
        }
        self.visited.push(offset);
        let self_index = self.copied.len();
        self.copied.push(CopiedIfd {
            entries: Vec::new(),
        });
        let Some((entries_start, count)) = ifd_entries(self.bytes, self.big_endian, offset) else {
            self.failed = true;
            return None;
        };
        self.mark(entries_start + count * 12 + 4);
        if self.failed {
            return None;
        }
        let mut sub_targets: Vec<(usize, usize)> = Vec::new();
        for index in 0..count {
            let Some((tag, field_type, value_count, value_at)) =
                ifd_entry(self.bytes, self.big_endian, entries_start, index)
            else {
                self.failed = true;
                return None;
            };
            let Some(type_size) = tiff_type_size(field_type) else {
                self.failed = true; // 长度未知的值区无法安全圈定
                return None;
            };
            let value_len = u64::from(value_count) * type_size;
            let (start, length) = if value_len <= 4 {
                (value_at, value_len as usize)
            } else {
                let Some(at) = tiff_u32(self.bytes, self.big_endian, value_at).map(|v| v as usize)
                else {
                    self.failed = true;
                    return None;
                };
                let Some(end) = at.checked_add(value_len as usize) else {
                    self.failed = true;
                    return None;
                };
                self.mark(end);
                if self.failed {
                    return None;
                }
                (at, value_len as usize)
            };
            let value = self.bytes[start..start + length].to_vec();
            if tag == 0x927C {
                self.maker_note = true;
            }
            if root {
                match tag {
                    0x8769 | 0x8825 if inline_single(field_type, value_count) => {
                        if let Some(at) =
                            tiff_u32(self.bytes, self.big_endian, value_at).map(|v| v as usize)
                        {
                            sub_targets.push((self.copied[self_index].entries.len(), at));
                        }
                    }
                    0x02BC => {
                        if self.xmp.is_some() {
                            self.failed = true; // 同一 IFD 出现两份 XMP 声明
                            return None;
                        }
                        self.xmp = Some(value.clone());
                    }
                    0x8773 => self.icc = Some(value.clone()),
                    0x0111 | 0x0144 | 0x0201 => {
                        match u32_values(&value, field_type, self.big_endian) {
                            Some(values) => self.strip_offsets.extend(values),
                            None => {
                                self.failed = true; // 无法解释条带位置就无法证明前缀干净
                                return None;
                            }
                        }
                    }
                    0x0117 | 0x0145 | 0x0202 => {
                        match u32_values(&value, field_type, self.big_endian) {
                            Some(values) => self.strip_counts.extend(values),
                            None => {
                                self.failed = true;
                                return None;
                            }
                        }
                    }
                    _ => {}
                }
            }
            self.copied[self_index].entries.push(CopiedEntry {
                tag,
                field_type,
                count: value_count,
                value,
                sub: None,
            });
        }
        for (entry_index, child_offset) in sub_targets {
            {
                let child = self.walk(child_offset, false, depth + 1)?;
                self.copied[self_index].entries[entry_index].sub = Some(child);
            }
        }
        Some(self_index)
    }
}

fn endian_u16(value: u16, big_endian: bool) -> [u8; 2] {
    if big_endian {
        value.to_be_bytes()
    } else {
        value.to_le_bytes()
    }
}

fn endian_u32(value: u32, big_endian: bool) -> [u8; 4] {
    if big_endian {
        value.to_be_bytes()
    } else {
        value.to_le_bytes()
    }
}

/// 交错布局的重排：所有字段值逐字节保留，按「头 + IFD0(+子 IFD) + 越界值区」
/// 重新落位，next-IFD 归零；除偏移与目录结构外不改任何字节。
fn build_relocated_tiff(ifds: &[CopiedIfd], big_endian: bool) -> Vec<u8> {
    let mut ifd_offsets = Vec::with_capacity(ifds.len());
    let mut cursor = 8usize;
    for ifd in ifds {
        ifd_offsets.push(cursor);
        cursor += 2 + ifd.entries.len() * 12 + 4;
    }
    // 越界值区分配偏移（偶数字节对齐），子 IFD 指针条目指向对应 IFD。
    let mut value_offsets: Vec<Vec<Option<usize>>> = ifds
        .iter()
        .map(|ifd| ifd.entries.iter().map(|_| None).collect())
        .collect();
    let mut data_cursor = cursor;
    for (ifd_index, ifd) in ifds.iter().enumerate() {
        for (entry_index, entry) in ifd.entries.iter().enumerate() {
            if entry.value.len() > 4 && entry.sub.is_none() {
                if data_cursor % 2 == 1 {
                    data_cursor += 1;
                }
                value_offsets[ifd_index][entry_index] = Some(data_cursor);
                data_cursor += entry.value.len();
            }
        }
    }
    let mut out = vec![0u8; data_cursor];
    out[0..2].copy_from_slice(if big_endian { b"MM" } else { b"II" });
    out[2..4].copy_from_slice(&endian_u16(42, big_endian));
    out[4..8].copy_from_slice(&endian_u32(ifd_offsets[0] as u32, big_endian));
    for (ifd_index, ifd) in ifds.iter().enumerate() {
        let at = ifd_offsets[ifd_index];
        out[at..at + 2].copy_from_slice(&endian_u16(ifd.entries.len() as u16, big_endian));
        for (entry_index, entry) in ifd.entries.iter().enumerate() {
            let entry_at = at + 2 + entry_index * 12;
            out[entry_at..entry_at + 2].copy_from_slice(&endian_u16(entry.tag, big_endian));
            out[entry_at + 2..entry_at + 4]
                .copy_from_slice(&endian_u16(entry.field_type, big_endian));
            out[entry_at + 4..entry_at + 8].copy_from_slice(&endian_u32(entry.count, big_endian));
            let pointer: u32 = if let Some(child) = entry.sub {
                ifd_offsets[child] as u32
            } else if entry.value.len() <= 4 {
                out[entry_at + 8..entry_at + 8 + entry.value.len()].copy_from_slice(&entry.value);
                continue;
            } else {
                let offset = value_offsets[ifd_index][entry_index].expect("越界值已分配偏移");
                out[offset..offset + entry.value.len()].copy_from_slice(&entry.value);
                offset as u32
            };
            out[entry_at + 8..entry_at + 12].copy_from_slice(&endian_u32(pointer, big_endian));
        }
        // next-IFD 指针保持 0：后续页不随重排载荷走。
    }
    out
}

/// TIFF 的元数据就是文件自身的 IFD 结构。布局干净（像素条带在元数据之后）时
/// 取「文件头 + IFD0 + Exif/GPS 子 IFD + 越界值区」整块前缀逐字节迁移；
/// 像素与元数据交错时（tiff 编码器的常见写法）改为重排最小载荷——字段值
/// 逐字节保留、只重写偏移——绝不把像素字节搬进副本。含 MakerNote 的交错
/// 文件重排后其内部绝对偏移可能失效，保守登记为不可承载并要求确认。
/// XMP（0x02BC）与 ICC（0x8773）另按值取出。
fn extract_tiff(bytes: &[u8], meta: &mut SourceMetadata) {
    let Some(big_endian) = tiff_order(bytes) else {
        return;
    };
    if tiff_u16(bytes, big_endian, 2) != Some(42) {
        // BigTIFF（magic 43）或损坏头：字段布局不同，本版不解析也不静默丢弃。
        meta.exif_unreadable = true;
        return;
    }
    let Some(ifd0) = tiff_u32(bytes, big_endian, 4).map(|value| value as usize) else {
        meta.exif_unreadable = true;
        return;
    };
    let mut walk = TiffWalk {
        bytes,
        big_endian,
        visited: Vec::new(),
        extent: 0,
        failed: false,
        xmp: None,
        icc: None,
        strip_offsets: Vec::new(),
        strip_counts: Vec::new(),
        copied: Vec::new(),
        maker_note: false,
    };
    let root = walk.walk(ifd0, true, 0);
    if let Some(packet) = walk.xmp {
        if packet.starts_with(b"<?xpacket") {
            meta.xmp.push(packet);
        } else {
            meta.xmp_broken = true;
        }
    }
    if let Some(profile) = walk.icc {
        meta.icc_raw = Some(profile);
    }
    if walk.failed || root != Some(0) {
        meta.exif_unreadable = true;
        return;
    }
    let interleaved = walk.strip_offsets.len() != walk.strip_counts.len()
        || walk
            .strip_offsets
            .iter()
            .zip(walk.strip_counts.iter())
            .any(|(offset, _count)| (*offset as usize) < walk.extent);
    if interleaved {
        if walk.maker_note {
            meta.tiff_layout_unsafe = true;
        } else {
            meta.exif_tiff = Some(build_relocated_tiff(&walk.copied, big_endian));
        }
        return;
    }
    meta.exif_tiff = Some(bytes[..walk.extent].to_vec());
}

/// PNG 数据块的三元组：块类型、数据字节、整块字节（含 CRC）。
type PngChunk<'a> = (&'a [u8; 4], &'a [u8], &'a [u8]);

/// 返回 PNG 数据块列表；签名或块越界即返回 None。
fn png_chunks(bytes: &[u8]) -> Option<Vec<PngChunk<'_>>> {
    if !bytes.starts_with(PNG_SIGNATURE) {
        return None;
    }
    let mut chunks = Vec::new();
    let mut index = PNG_SIGNATURE.len();
    while index + 12 <= bytes.len() {
        let size = u32::from_be_bytes(bytes[index..index + 4].try_into().unwrap()) as usize;
        let next = index.checked_add(12)?.checked_add(size)?;
        if next > bytes.len() {
            return None;
        }
        let kind: &[u8; 4] = bytes[index + 4..index + 8].try_into().unwrap();
        chunks.push((
            kind,
            &bytes[index + 8..index + 8 + size],
            &bytes[index..next],
        ));
        if kind == b"IEND" {
            return Some(chunks);
        }
        index = next;
    }
    None
}

fn chunk_kind(chunk: &[u8]) -> Option<&[u8; 4]> {
    chunk.get(4..8).and_then(|slice| slice.try_into().ok())
}

fn decompress_iccp(data: &[u8]) -> Option<Vec<u8>> {
    let split = data.iter().position(|byte| *byte == 0)?;
    let compressed = data.get(split + 2..)?;
    let mut profile = Vec::new();
    ZlibDecoder::new(compressed)
        .read_to_end(&mut profile)
        .ok()?;
    Some(profile)
}

/// iTXt 的 XMP 载荷（标准未压缩形式与 zlib 压缩形式都支持）；非 XMP 返回 None。
fn png_itext_payload(data: &[u8]) -> Option<Vec<u8>> {
    if !data.starts_with(PNG_XMP_KEYWORD) || data.len() < PNG_XMP_KEYWORD.len() + 3 {
        return None;
    }
    let rest = &data[PNG_XMP_KEYWORD.len() + 1..]; // 跳过 keyword 与其结尾 \0
    let compressed = rest[0] == 1;
    let body = &rest[2..]; // 跳过压缩标志与压缩方法
    let split = body.iter().position(|byte| *byte == 0)?;
    let text = &body[split + 1..];
    if !text.starts_with(b"<?xpacket") {
        return None;
    }
    if compressed {
        let mut packet = Vec::new();
        if ZlibDecoder::new(text)
            .read_to_end(&mut packet)
            .is_ok_and(|_| packet.starts_with(b"<?xpacket"))
        {
            Some(packet)
        } else {
            None
        }
    } else {
        Some(text.to_vec())
    }
}

// ---------- EXIF TIFF 定点手术 ----------

fn tiff_order(tiff: &[u8]) -> Option<bool> {
    match tiff.get(..2) {
        Some(b"II") => Some(false),
        Some(b"MM") => Some(true),
        _ => None,
    }
}

fn tiff_u16(tiff: &[u8], big_endian: bool, at: usize) -> Option<u16> {
    let bytes = tiff.get(at..at + 2)?;
    Some(if big_endian {
        u16::from_be_bytes(bytes.try_into().ok()?)
    } else {
        u16::from_le_bytes(bytes.try_into().ok()?)
    })
}

fn tiff_u32(tiff: &[u8], big_endian: bool, at: usize) -> Option<u32> {
    let bytes = tiff.get(at..at + 4)?;
    Some(if big_endian {
        u32::from_be_bytes(bytes.try_into().ok()?)
    } else {
        u32::from_le_bytes(bytes.try_into().ok()?)
    })
}

/// IFD 目录范围：返回 (条目区起点, 条目数)。条目区起点前 2 字节是条目数。
fn ifd_entries(tiff: &[u8], big_endian: bool, offset: usize) -> Option<(usize, usize)> {
    let count = tiff_u16(tiff, big_endian, offset)? as usize;
    let start = offset.checked_add(2)?;
    let end = start.checked_add(count.checked_mul(12)?)?.checked_add(4)?;
    if end > tiff.len() {
        return None;
    }
    Some((start, count))
}

/// 条目 = (标签, 类型, 数量, 值字段在载荷中的偏移)。
fn ifd_entry(
    tiff: &[u8],
    big_endian: bool,
    entries_start: usize,
    index: usize,
) -> Option<(u16, u16, u32, usize)> {
    let at = entries_start.checked_add(index.checked_mul(12)?)?;
    let tag = tiff_u16(tiff, big_endian, at)?;
    let field_type = tiff_u16(tiff, big_endian, at + 2)?;
    let count = tiff_u32(tiff, big_endian, at + 4)?;
    Some((tag, field_type, count, at + 8))
}

fn write_u16(tiff: &mut [u8], big_endian: bool, at: usize, value: u16) {
    let bytes = if big_endian {
        value.to_be_bytes()
    } else {
        value.to_le_bytes()
    };
    tiff[at..at + 2].copy_from_slice(&bytes);
}

fn write_u32(tiff: &mut [u8], big_endian: bool, at: usize, value: u32) {
    let bytes = if big_endian {
        value.to_be_bytes()
    } else {
        value.to_le_bytes()
    };
    tiff[at..at + 4].copy_from_slice(&bytes);
}

/// 单值 SHORT(3)/LONG(4) 条目才允许内联改写。
fn inline_single(field_type: u16, count: u32) -> bool {
    count == 1 && matches!(field_type, 3 | 4)
}

/// 定点修正 EXIF：像素已旋正时把方向条目改写为 1，尺寸条目同步为最终像素，
/// 越界悬挂的 next-IFD 指针归零（TIFF 源前缀不含后续页）。其余字节一律不动，
/// 未知字段原样保留。需要归一方向却无法改写时宁可拒绝迁移，也不让副本被查看器
/// 二次旋转；载荷损坏且方向本就是 1 时按原样搬运。
fn patch_tiff(tiff: &mut [u8], clear_orientation: bool, dims: (u32, u32)) -> Result<(), String> {
    let refuse = || "EXIF 方向条目无法归一化，为避免二次旋转已拒绝迁移".to_string();
    let Some(big_endian) = tiff_order(tiff) else {
        return if clear_orientation {
            Err(refuse())
        } else {
            Ok(())
        };
    };
    let Some(ifd0) = tiff_u32(tiff, big_endian, 4).map(|value| value as usize) else {
        return if clear_orientation {
            Err(refuse())
        } else {
            Ok(())
        };
    };
    let Some((entries_start, count)) = ifd_entries(tiff, big_endian, ifd0) else {
        return if clear_orientation {
            Err(refuse())
        } else {
            Ok(())
        };
    };
    let mut sub_ifd_start = None;
    // TIFF 源的前缀载荷不包含后续页：next-IFD 指针越界悬挂时归零，
    // 指向载荷内部的 IFD1（如 JPEG EXIF 的缩略图）保持原样。
    let next_at = entries_start + count * 12;
    if let Some(next) = tiff_u32(tiff, big_endian, next_at).map(|value| value as usize) {
        if next != 0 && next + 4 > tiff.len() {
            write_u32(tiff, big_endian, next_at, 0);
        }
    }
    for index in 0..count {
        let Some((tag, field_type, value_count, value_at)) =
            ifd_entry(tiff, big_endian, entries_start, index)
        else {
            return if clear_orientation {
                Err(refuse())
            } else {
                Ok(())
            };
        };
        match tag {
            0x0112 if clear_orientation => {
                if !inline_single(field_type, value_count) {
                    return Err(refuse());
                }
                if field_type == 3 {
                    write_u16(tiff, big_endian, value_at, 1);
                } else {
                    write_u32(tiff, big_endian, value_at, 1);
                }
            }
            0xA002 if inline_single(field_type, value_count) => {
                write_u16(tiff, big_endian, value_at - 6, 4);
                write_u32(tiff, big_endian, value_at, dims.0);
            }
            0xA003 if inline_single(field_type, value_count) => {
                write_u16(tiff, big_endian, value_at - 6, 4);
                write_u32(tiff, big_endian, value_at, dims.1);
            }
            0x8769 if inline_single(field_type, value_count) => {
                sub_ifd_start = tiff_u32(tiff, big_endian, value_at).map(|value| value as usize);
            }
            _ => {}
        }
    }
    if let Some(sub) = sub_ifd_start {
        if let Some((sub_start, sub_count)) = ifd_entries(tiff, big_endian, sub) {
            for index in 0..sub_count {
                let Some((tag, field_type, value_count, value_at)) =
                    ifd_entry(tiff, big_endian, sub_start, index)
                else {
                    break;
                };
                if !inline_single(field_type, value_count) {
                    continue;
                }
                if tag == 0xA002 {
                    write_u16(tiff, big_endian, value_at - 6, 4);
                    write_u32(tiff, big_endian, value_at, dims.0);
                } else if tag == 0xA003 {
                    write_u16(tiff, big_endian, value_at - 6, 4);
                    write_u32(tiff, big_endian, value_at, dims.1);
                }
            }
        }
    }
    Ok(())
}

/// 统计 IFD0 与 Exif 子 IFD 的条目数，仅用于结果说明。
pub fn exif_field_count(tiff: &[u8]) -> usize {
    let Some(big_endian) = tiff_order(tiff) else {
        return 0;
    };
    let Some(ifd0) = tiff_u32(tiff, big_endian, 4).map(|value| value as usize) else {
        return 0;
    };
    let Some((entries_start, count)) = ifd_entries(tiff, big_endian, ifd0) else {
        return 0;
    };
    let mut total = count;
    for index in 0..count {
        if let Some((0x8769, field_type, value_count, value_at)) =
            ifd_entry(tiff, big_endian, entries_start, index)
        {
            if inline_single(field_type, value_count) {
                if let Some(sub) = tiff_u32(tiff, big_endian, value_at).map(|v| v as usize) {
                    if let Some((_, sub_count)) = ifd_entries(tiff, big_endian, sub) {
                        total += sub_count;
                    }
                }
            }
        }
    }
    total
}

/// 读 IFD0 方向条目；载荷损坏或没有方向条目返回 0。
#[cfg_attr(not(test), allow(dead_code))]
pub fn orientation_of_tiff(tiff: &[u8]) -> u16 {
    let Some(big_endian) = tiff_order(tiff) else {
        return 0;
    };
    let Some(ifd0) = tiff_u32(tiff, big_endian, 4).map(|value| value as usize) else {
        return 0;
    };
    let Some((start, count)) = ifd_entries(tiff, big_endian, ifd0) else {
        return 0;
    };
    for index in 0..count {
        if let Some((0x0112, field_type, 1, at)) = ifd_entry(tiff, big_endian, start, index) {
            return if field_type == 3 {
                tiff_u16(tiff, big_endian, at).unwrap_or(0)
            } else {
                tiff_u32(tiff, big_endian, at).unwrap_or(0) as u16
            };
        }
    }
    0
}

// ---------- 迁移计划与执行 ----------

/// EXIF 载荷（含 Exif\0\0 头）能否写进单个 JPEG 段。
fn exif_fits_jpeg(tiff: &[u8]) -> bool {
    tiff.len() + EXIF_HEADER.len() <= JPEG_SEGMENT_MAX
}

/// XMP 包（含标准头）能否写进单个 JPEG APP1 段。
fn xmp_fits_jpeg(packet: &[u8]) -> bool {
    packet.len() + XMP_HEADER.len() <= JPEG_SEGMENT_MAX
}

/// 列出目标容器无法承载的源字段。空表 = 全部可迁移；非空时需用户明确选择。
pub fn uncarrivable(source: &SourceMetadata, target: Kind, include_xmp: bool) -> Vec<&'static str> {
    let mut list = Vec::new();
    if source.duplicate_exif {
        list.push("重复的 EXIF 段");
    }
    if source.icc_broken {
        list.push("不完整的 ICC 段");
    }
    if source.xmp_broken {
        list.push("不完整的 XMP 段");
    }
    if source.exif_unreadable {
        list.push("无法解析的 EXIF（BigTIFF 或损坏结构）");
    }
    if source.icc_linked {
        list.push("外链的 ICC 色彩配置（指向外部文件）");
    }
    if source.tiff_layout_unsafe {
        list.push("与像素交错的 TIFF 元数据");
    }
    if source.tiff_foreign_page {
        list.push("所选页之外的 EXIF/ICC（记录在第 1 页）");
    }
    let has_text = source.png_chunks.iter().any(|chunk| {
        matches!(
            chunk_kind(chunk),
            Some(b"tEXt") | Some(b"zTXt") | Some(b"iTXt")
        )
    });
    let has_color = source.png_chunks.iter().any(|chunk| {
        matches!(
            chunk_kind(chunk),
            Some(b"gAMA") | Some(b"cHRM") | Some(b"sRGB") | Some(b"cICP")
        )
    });
    match target {
        Kind::Jpeg => {
            if let Some(tiff) = &source.exif_tiff {
                if !exif_fits_jpeg(tiff) {
                    list.push("超过 JPEG 单段上限的 EXIF 载荷");
                }
            }
            if include_xmp && source.xmp.iter().any(|packet| !xmp_fits_jpeg(packet)) {
                list.push("超过 JPEG 单段上限的 XMP 包");
            }
            if has_text {
                list.push("PNG 文本字段（含 AIGC 文本声明）");
            }
            if has_color {
                list.push("PNG 色彩块（gAMA/sRGB 等）");
            }
        }
        Kind::Png => {}
        _ => {
            if source.exif_tiff.is_some() {
                list.push("EXIF 拍摄信息");
            }
            if source.icc_raw.is_some() || source.icc_png_chunk.is_some() {
                list.push("ICC 色彩配置");
            }
            if include_xmp && !source.xmp.is_empty() {
                list.push("XMP 声明");
            }
            if has_text {
                list.push("PNG 文本字段");
            }
            if has_color {
                list.push("PNG 色彩块");
            }
        }
    }
    list
}

/// 迁移结果摘要，同时保存复检期望值。
#[derive(Debug, Clone, Default)]
pub struct Carried {
    pub exif_fields: usize,
    pub icc: bool,
    pub xmp_packets: usize,
    pub png_chunks: usize,
    expected_exif: Option<Vec<u8>>,
    expected_icc: Option<Vec<u8>>,
    expected_xmp: Vec<Vec<u8>>,
    expected_png_chunks: Vec<Vec<u8>>,
}

/// 把源容器迁移进刚编码完成的目标字节。调用前须先经 `uncarrivable` 确认
/// 用户已明确接受丢弃项；本函数只搬运可承载的部分。
pub fn carry_into(
    encoded: &mut Vec<u8>,
    target: Kind,
    source: &SourceMetadata,
    include_xmp: bool,
    orientation_observed: u16,
    dims: (u32, u32),
) -> Result<Carried, String> {
    let clear_orientation = (2..=8).contains(&orientation_observed);
    let mut carried = Carried::default();
    if let Some(tiff) = &source.exif_tiff {
        let mut patched = tiff.clone();
        patch_tiff(&mut patched, clear_orientation, dims)?;
        if matches!(target, Kind::Jpeg) && !exif_fits_jpeg(&patched) {
            // 超过 JPEG 单段上限：uncarrivable 已列出，经用户确认后丢弃。
        } else {
            carried.exif_fields = exif_field_count(&patched);
            carried.expected_exif = Some(patched);
        }
    }
    if source.icc_raw.is_some() {
        carried.icc = true;
        carried.expected_icc = source.icc_raw.clone();
    }
    if include_xmp {
        // JPEG 目标装不下的包已在 uncarrivable 列出并经确认丢弃；期望值只记实际写入的包。
        carried.expected_xmp = if matches!(target, Kind::Jpeg) {
            source
                .xmp
                .iter()
                .filter(|packet| xmp_fits_jpeg(packet))
                .cloned()
                .collect()
        } else {
            source.xmp.clone()
        };
        carried.xmp_packets = carried.expected_xmp.len();
    }
    match target {
        Kind::Jpeg => {
            let mut segments = Vec::new();
            if let Some(patched) = &carried.expected_exif {
                let mut payload = EXIF_HEADER.to_vec();
                payload.extend_from_slice(patched);
                segments.push(jpeg_segment(0xE1, &payload)?);
            }
            if let Some(profile) = &source.icc_raw {
                let total = profile.len().div_ceil(ICC_SEGMENT_MAX).max(1);
                for (index, start) in (0..profile.len()).step_by(ICC_SEGMENT_MAX).enumerate() {
                    let end = (start + ICC_SEGMENT_MAX).min(profile.len());
                    let mut payload = ICC_MARKER.to_vec();
                    payload.push((index + 1) as u8);
                    payload.push(total as u8);
                    payload.extend_from_slice(&profile[start..end]);
                    segments.push(jpeg_segment(0xE2, &payload)?);
                }
            }
            if include_xmp {
                for packet in &source.xmp {
                    if !xmp_fits_jpeg(packet) {
                        continue; // 已在 uncarrivable 中列出并经用户确认丢弃
                    }
                    let mut payload = XMP_HEADER.to_vec();
                    payload.extend_from_slice(packet);
                    segments.push(jpeg_segment(0xE1, &payload)?);
                }
            }
            jpeg_insert_after_app0(encoded, &segments)?;
        }
        Kind::Png => {
            let mut chunks: Vec<Vec<u8>> = Vec::new();
            if let Some(patched) = &carried.expected_exif {
                chunks.push(png_chunk(b"eXIf", patched));
            }
            if let Some(profile) = &source.icc_raw {
                let chunk = match &source.icc_png_chunk {
                    Some(verbatim) => verbatim.clone(),
                    None => {
                        let mut data = b"ICC profile\0".to_vec();
                        data.push(0);
                        data.extend_from_slice(&zlib_compress(profile)?);
                        png_chunk(b"iCCP", &data)
                    }
                };
                chunks.push(chunk);
            }
            chunks.extend(source.png_chunks.iter().cloned());
            if include_xmp {
                for packet in &source.xmp {
                    let mut data = PNG_XMP_KEYWORD.to_vec();
                    data.extend_from_slice(&[0, 0, 0, 0]);
                    data.extend_from_slice(packet);
                    chunks.push(png_chunk(b"iTXt", &data));
                }
            }
            carried.png_chunks = source.png_chunks.len();
            carried.expected_png_chunks = source.png_chunks.clone();
            png_insert_after_ihdr(encoded, &chunks)?;
        }
        _ => return Err("该目标格式不参与容器迁移".into()),
    }
    Ok(carried)
}

fn zlib_compress(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(data)
        .and_then(|_| encoder.finish())
        .map_err(|error| format!("ICC 压缩失败：{error}"))
}

fn jpeg_segment(marker: u8, payload: &[u8]) -> Result<Vec<u8>, String> {
    let length = payload.len() + 2;
    if length > u16::MAX as usize {
        return Err("元数据段超过 JPEG 单段上限，无法嵌入".into());
    }
    let mut segment = vec![0xFF, marker];
    segment.extend_from_slice(&(length as u16).to_be_bytes());
    segment.extend_from_slice(payload);
    Ok(segment)
}

fn jpeg_insert_after_app0(bytes: &mut Vec<u8>, segments: &[Vec<u8>]) -> Result<(), String> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err("目标不是 JPEG，无法迁移".into());
    }
    let mut insert_at = 2usize;
    if bytes.len() >= 6 && bytes[2] == 0xFF && bytes[3] == 0xE0 {
        let size = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
        if size < 2 {
            return Err("目标 JPEG 段损坏".into());
        }
        insert_at = 4 + size;
    }
    let mut spliced = bytes[..insert_at].to_vec();
    for segment in segments {
        spliced.extend_from_slice(segment);
    }
    spliced.extend_from_slice(&bytes[insert_at..]);
    *bytes = spliced;
    Ok(())
}

fn png_insert_after_ihdr(bytes: &mut Vec<u8>, chunks: &[Vec<u8>]) -> Result<(), String> {
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("目标不是 PNG，无法迁移".into());
    }
    if bytes.len() < 33 || &bytes[12..16] != b"IHDR" {
        return Err("目标 PNG 结构异常，无法迁移".into());
    }
    let mut spliced = bytes[..33].to_vec();
    for chunk in chunks {
        spliced.extend_from_slice(chunk);
    }
    spliced.extend_from_slice(&bytes[33..]);
    *bytes = spliced;
    Ok(())
}

/// 迁移复检：从最终字节重新提取，与写入期望逐字节比对；任何不一致都算失败。
pub fn verify(encoded: &[u8], target: Kind, carried: &Carried) -> Result<(), String> {
    let extracted = extract(encoded, target);
    match (&carried.expected_exif, &extracted.exif_tiff) {
        (Some(expected), Some(actual)) if expected != actual => {
            return Err("迁移复检失败：EXIF 载荷与源文件不一致".into());
        }
        (Some(_), None) => return Err("迁移复检失败：副本缺少 EXIF".into()),
        _ => {}
    }
    if let Some(expected) = &carried.expected_icc {
        match &extracted.icc_raw {
            Some(actual) if actual == expected => {}
            _ => return Err("迁移复检失败：ICC 色彩配置与源文件不一致".into()),
        }
    }
    if extracted.xmp != carried.expected_xmp {
        return Err("迁移复检失败：XMP 声明与源文件不一致".into());
    }
    if extracted.png_chunks != carried.expected_png_chunks {
        return Err("迁移复检失败：PNG 文本或色彩块不完整".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod fixtures {
    use image::{ImageBuffer, Rgb};

    use super::*;

    /// 手工构造小端 TIFF EXIF：IFD0（Make 越界值、Orientation、ExifIFD 指针）
    /// 加子 IFD（宽、高、未公开厂商标签 0xC612 越界值）。
    ///
    /// 不依赖 exif 写入器，未知标签与越界数据字节完全可控。
    pub(crate) fn tiff_exif(orientation: u16, width: u32, height: u32) -> Vec<u8> {
        let make = b"Chunjun Test Camera\0\0\0";
        let vendor = [0x5A, 0xC6, 0x12, 0xAA, 0x99, 0x37, 0x21, 0x08];
        let ifd0_offset = 8usize;
        let sub_offset = 8 + 2 + 3 * 12 + 4;
        let data_offset = sub_offset + 2 + 3 * 12 + 4;
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&(ifd0_offset as u32).to_le_bytes());
        // IFD0：Make（ASCII，越界）、Orientation（SHORT 内联）、ExifIFDPointer。
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&0x010Fu16.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&(make.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&(data_offset as u32).to_le_bytes());
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&0u16.to_le_bytes());
        tiff.extend_from_slice(&0x8769u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&(sub_offset as u32).to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        // 子 IFD：宽、高（LONG 内联）、未公开厂商标签（UNDEFINED 越界）。
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&0xA002u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&width.to_le_bytes());
        tiff.extend_from_slice(&0xA003u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&height.to_le_bytes());
        tiff.extend_from_slice(&0xC612u16.to_le_bytes());
        tiff.extend_from_slice(&7u16.to_le_bytes());
        tiff.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&((data_offset + make.len()) as u32).to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff.extend_from_slice(make);
        tiff.extend_from_slice(&vendor);
        tiff
    }

    /// 可识别的假 ICC 档案字节；只验证搬运，不宣称色彩管理。
    pub(crate) fn fake_icc() -> Vec<u8> {
        (0..220u32).map(|index| (index % 251) as u8).collect()
    }

    /// 未公开厂商标签的越界值图案；TIFF 源夹具以它开头以便断言逐字节保留。
    pub(crate) const VENDOR_MARK: [u8; 8] = [0x5A, 0xC6, 0x12, 0xAA, 0x99, 0x37, 0x21, 0x08];

    pub(crate) fn known_xmp() -> Vec<u8> {
        "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:AIGC=\"http://www.tc260.org.cn/ns/AIGC/1.0/\"><rdf:Description rdf:about=\"\"><AIGC:Label>1</AIGC:Label><AIGC:ContentProducer>即梦/豆包</AIGC:ContentProducer><AIGC:ProduceID>chunjun-produce-1</AIGC:ProduceID></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>".as_bytes().to_vec()
    }

    fn base_image() -> ImageBuffer<Rgb<u8>, Vec<u8>> {
        ImageBuffer::from_fn(32, 24, |x, y| {
            Rgb([(x * 8 % 255) as u8, (y * 10 % 255) as u8, 90])
        })
    }

    fn write_image(format: image::ImageFormat) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(base_image())
            .write_to(&mut std::io::Cursor::new(&mut bytes), format)
            .unwrap();
        bytes
    }

    pub(crate) fn base_jpeg() -> Vec<u8> {
        write_image(image::ImageFormat::Jpeg)
    }

    pub(crate) fn base_png() -> Vec<u8> {
        write_image(image::ImageFormat::Png)
    }

    pub(crate) fn base_webp() -> Vec<u8> {
        write_image(image::ImageFormat::WebP)
    }

    pub(crate) fn jpeg_with(
        exif: Option<&[u8]>,
        icc: Option<&[u8]>,
        xmp: Option<&[u8]>,
    ) -> Vec<u8> {
        let mut bytes = base_jpeg();
        let mut segments = Vec::new();
        if let Some(tiff) = exif {
            let mut payload = EXIF_HEADER.to_vec();
            payload.extend_from_slice(tiff);
            segments.push(jpeg_segment(0xE1, &payload).unwrap());
        }
        if let Some(profile) = icc {
            let mut payload = ICC_MARKER.to_vec();
            payload.extend_from_slice(&[1, 1]);
            payload.extend_from_slice(profile);
            segments.push(jpeg_segment(0xE2, &payload).unwrap());
        }
        if let Some(packet) = xmp {
            let mut payload = XMP_HEADER.to_vec();
            payload.extend_from_slice(packet);
            segments.push(jpeg_segment(0xE1, &payload).unwrap());
        }
        jpeg_insert_after_app0(&mut bytes, &segments).unwrap();
        bytes
    }

    pub(crate) fn png_with(
        exif: Option<&[u8]>,
        icc: Option<&[u8]>,
        xmp: Option<&[u8]>,
        extra: Option<(&'static [u8; 4], &[u8])>,
    ) -> Vec<u8> {
        let mut bytes = base_png();
        let mut chunks = Vec::new();
        if let Some(tiff) = exif {
            chunks.push(png_chunk(b"eXIf", tiff));
        }
        if let Some(profile) = icc {
            let mut data = b"ICC profile\0".to_vec();
            data.push(0);
            data.extend_from_slice(&zlib_compress(profile).unwrap());
            chunks.push(png_chunk(b"iCCP", &data));
        }
        if let Some(packet) = xmp {
            let mut data = PNG_XMP_KEYWORD.to_vec();
            data.extend_from_slice(&[0, 0, 0, 0]);
            data.extend_from_slice(packet);
            chunks.push(png_chunk(b"iTXt", &data));
        }
        if let Some((kind, data)) = extra {
            chunks.push(png_chunk(kind, data));
        }
        png_insert_after_ihdr(&mut bytes, &chunks).unwrap();
        bytes
    }

    pub(crate) fn webp_with(exif: Option<&[u8]>, with_prefix: bool) -> Vec<u8> {
        let bytes = base_webp();
        let Some(tiff) = exif else {
            return bytes;
        };
        let mut data = Vec::new();
        if with_prefix {
            data.extend_from_slice(EXIF_HEADER);
        }
        data.extend_from_slice(tiff);
        let mut chunk = b"EXIF".to_vec();
        chunk.extend_from_slice(&(data.len() as u32).to_le_bytes());
        chunk.extend_from_slice(&data);
        if data.len() % 2 == 1 {
            chunk.push(0);
        }
        let mut spliced = bytes[..12].to_vec();
        spliced.extend_from_slice(&chunk);
        spliced.extend_from_slice(&bytes[12..]);
        let total = (spliced.len() - 8) as u32;
        spliced[4..8].copy_from_slice(&total.to_le_bytes());
        spliced
    }

    fn tiff_entry(tag: u16, field_type: u16, count: u32, value: u32) -> [u8; 12] {
        let mut entry = [0u8; 12];
        entry[0..2].copy_from_slice(&tag.to_le_bytes());
        entry[2..4].copy_from_slice(&field_type.to_le_bytes());
        entry[4..8].copy_from_slice(&count.to_le_bytes());
        entry[8..12].copy_from_slice(&value.to_le_bytes());
        entry
    }

    /// 手工构造可解码的单页灰度 TIFF：IFD0 带图像必需标签、Orientation、
    /// Exif 子 IFD（宽/高/厂商标签）与可选 XMP(0x02BC)/ICC(0x8773)。
    /// `vendor_len` 可放大厂商标签制造超限载荷；`interleave` 把像素条带挪到
    /// 元数据值区之前，构造交错布局。
    pub(crate) fn tiff_source(
        orientation: u16,
        xmp: Option<&[u8]>,
        icc: Option<&[u8]>,
        vendor_len: usize,
        interleave: bool,
    ) -> Vec<u8> {
        tiff_source_with_vendor(orientation, xmp, icc, vendor_len, interleave, 0xC612)
    }

    /// 同 `tiff_source`，但可指定子 IFD 里的大块厂商标签号（如 MakerNote 0x927C）。
    pub(crate) fn tiff_source_with_vendor(
        orientation: u16,
        xmp: Option<&[u8]>,
        icc: Option<&[u8]>,
        vendor_len: usize,
        interleave: bool,
        vendor_tag: u16,
    ) -> Vec<u8> {
        let (width, height) = (32u32, 24u32);
        let strip_len = (width * height) as usize;
        let mut vendor: Vec<u8> = VENDOR_MARK.to_vec();
        vendor.extend(
            (0..vendor_len.saturating_sub(VENDOR_MARK.len())).map(|index| (index % 251) as u8),
        );
        let count = 10 + usize::from(xmp.is_some()) + usize::from(icc.is_some()) + 1;
        let ifd0_at = 8usize;
        let sub_at = ifd0_at + 2 + count * 12 + 4;
        let sub_len = 2 + 3 * 12 + 4;
        let early_strip_at = sub_at + sub_len;
        let mut cursor = if interleave {
            early_strip_at + strip_len
        } else {
            early_strip_at
        };
        let xmp_at = xmp.map(|packet| {
            let at = cursor;
            cursor += packet.len();
            at
        });
        let icc_at = icc.map(|profile| {
            let at = cursor;
            cursor += profile.len();
            at
        });
        let vendor_at = cursor;
        let values_end = vendor_at + vendor.len();
        let strip_at = if interleave {
            early_strip_at
        } else {
            values_end
        };
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&(ifd0_at as u32).to_le_bytes());
        tiff.extend_from_slice(&(count as u16).to_le_bytes());
        for entry in [
            tiff_entry(0x0100, 4, 1, width),
            tiff_entry(0x0101, 4, 1, height),
            tiff_entry(0x0102, 3, 1, 8),
            tiff_entry(0x0103, 3, 1, 1),
            tiff_entry(0x0106, 3, 1, 1),
            tiff_entry(0x0111, 4, 1, strip_at as u32),
            tiff_entry(0x0112, 3, 1, u32::from(orientation)),
            tiff_entry(0x0115, 3, 1, 1),
            tiff_entry(0x0116, 4, 1, height),
            tiff_entry(0x0117, 4, 1, strip_len as u32),
        ] {
            tiff.extend_from_slice(&entry);
        }
        if let Some(packet) = xmp {
            tiff.extend_from_slice(&tiff_entry(
                0x02BC,
                7,
                packet.len() as u32,
                xmp_at.unwrap() as u32,
            ));
        }
        tiff.extend_from_slice(&tiff_entry(0x8769, 4, 1, sub_at as u32));
        if let Some(profile) = icc {
            tiff.extend_from_slice(&tiff_entry(
                0x8773,
                7,
                profile.len() as u32,
                icc_at.unwrap() as u32,
            ));
        }
        tiff.extend_from_slice(&0u32.to_le_bytes());
        // Exif 子 IFD：宽、高、厂商标签（越界值）。
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&tiff_entry(0xA002, 4, 1, width));
        tiff.extend_from_slice(&tiff_entry(0xA003, 4, 1, height));
        tiff.extend_from_slice(&tiff_entry(
            vendor_tag,
            7,
            vendor.len() as u32,
            vendor_at as u32,
        ));
        tiff.extend_from_slice(&0u32.to_le_bytes());
        if interleave {
            tiff.extend(std::iter::repeat_n(0xA5u8, strip_len));
        }
        if let Some(packet) = xmp {
            tiff.extend_from_slice(packet);
        }
        if let Some(profile) = icc {
            tiff.extend_from_slice(profile);
        }
        tiff.extend_from_slice(&vendor);
        if !interleave {
            tiff.extend(std::iter::repeat_n(0x5Au8, strip_len));
        }
        tiff
    }

    /// 手工构造两页灰度 TIFF（未压缩，页 1/页 2 填充值不同），用于页选择回归。
    pub(crate) fn tiff_two_pages(fill_a: u8, fill_b: u8) -> Vec<u8> {
        let (width, height) = (16u32, 12u32);
        let strip_len = (width * height) as usize;
        let entries = 9usize;
        let ifd0_at = 8usize;
        let ifd1_at = ifd0_at + 2 + entries * 12 + 4;
        let strip_a_at = ifd1_at + 2 + entries * 12 + 4;
        let strip_b_at = strip_a_at + strip_len;
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&(ifd0_at as u32).to_le_bytes());
        for (page, strip_at, next) in [
            (ifd0_at, strip_a_at, ifd1_at as u32),
            (ifd1_at, strip_b_at, 0),
        ] {
            debug_assert_eq!(tiff.len(), page);
            tiff.extend_from_slice(&(entries as u16).to_le_bytes());
            for entry in [
                tiff_entry(0x0100, 4, 1, width),
                tiff_entry(0x0101, 4, 1, height),
                tiff_entry(0x0102, 3, 1, 8),
                tiff_entry(0x0103, 3, 1, 1),
                tiff_entry(0x0106, 3, 1, 1),
                tiff_entry(0x0111, 4, 1, strip_at as u32),
                tiff_entry(0x0115, 3, 1, 1),
                tiff_entry(0x0116, 4, 1, height),
                tiff_entry(0x0117, 4, 1, strip_len as u32),
            ] {
                tiff.extend_from_slice(&entry);
            }
            tiff.extend_from_slice(&next.to_le_bytes());
        }
        tiff.extend(std::iter::repeat_n(fill_a, strip_len));
        tiff.extend(std::iter::repeat_n(fill_b, strip_len));
        tiff
    }

    /// GIF：在图像数据与结尾 0x3B 之间插入 XMP 应用扩展块；`truncate` 去掉
    /// 结束符，模拟截断的子块序列。
    pub(crate) fn gif_with(xmp: Option<&[u8]>, truncate: bool) -> Vec<u8> {
        let mut bytes = write_image(image::ImageFormat::Gif);
        let Some(packet) = xmp else {
            return bytes;
        };
        assert_eq!(bytes.pop(), Some(0x3B), "GIF 应以 0x3B 结束");
        bytes.extend_from_slice(&[0x21, 0xFF, 0x0B]);
        bytes.extend_from_slice(GIF_XMP_MAGIC);
        for chunk in packet.chunks(255) {
            bytes.push(chunk.len() as u8);
            bytes.extend_from_slice(chunk);
        }
        if !truncate {
            bytes.push(0);
        }
        bytes.push(0x3B);
        bytes
    }

    /// 最小 SVG，可选在 <metadata> 内嵌 xpacket。
    pub(crate) fn svg_with(xmp: Option<&[u8]>) -> Vec<u8> {
        let inner = xmp
            .map(|packet| String::from_utf8_lossy(packet).to_string())
            .unwrap_or_default();
        let fill = format!("#{:06X}", 0x276650);
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><metadata>{inner}</metadata><rect width="32" height="24" fill="{fill}"/></svg>"#
        )
        .into_bytes()
    }

    /// 24 位 BMP 加 V5 头；`profile` 内嵌（MBED），`linked` 改为外链（LINK）。
    pub(crate) fn bmp_v5(profile: Option<&[u8]>, linked: bool) -> Vec<u8> {
        let pixel_bytes = 12usize;
        let header_len = 14 + 124;
        let profile_at = header_len + pixel_bytes;
        let profile_len = profile.map(|bytes| bytes.len()).unwrap_or(0);
        let file_len = header_len + pixel_bytes + profile_len;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"BM");
        bytes.extend_from_slice(&(file_len as u32).to_le_bytes());
        bytes.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(&(header_len as u32).to_le_bytes());
        bytes.extend_from_slice(&124u32.to_le_bytes());
        bytes.extend_from_slice(&2i32.to_le_bytes());
        bytes.extend_from_slice(&2i32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&24u16.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
        bytes.extend_from_slice(&[0; 16]); // 分辨率与调色板计数
        bytes.extend_from_slice(&[0; 16]); // 通道掩码
        let cs_type: &[u8] = if linked {
            b"LINK"
        } else if profile.is_some() {
            b"MBED"
        } else {
            b"sRGB"
        };
        bytes.extend_from_slice(cs_type); // DIB+56 bV5CSType
        bytes.extend_from_slice(&[0; 48]); // 端点与伽马
        bytes.extend_from_slice(&0u32.to_le_bytes()); // DIB+100 bV5Intent
        let offset_from_dib = if linked || profile.is_some() {
            profile_at - 14
        } else {
            0
        };
        bytes.extend_from_slice(&(offset_from_dib as u32).to_le_bytes()); // DIB+112
        bytes.extend_from_slice(&(profile_len as u32).to_le_bytes()); // DIB+116
        bytes.extend_from_slice(&0u32.to_le_bytes()); // DIB+120 保留
        assert_eq!(bytes.len(), header_len, "V5 头应为 124 字节");
        bytes.extend_from_slice(&[
            0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xA0, 0xB0, 0xC0,
        ]);
        if let Some(profile) = profile {
            bytes.extend_from_slice(profile);
        }
        bytes
    }

    /// 超长 XMP 包：以合法 xpacket 包裹填充内容，用于 ExtendedXMP 与超限场景。
    pub(crate) fn long_xpacket(fill: usize) -> Vec<u8> {
        let mut packet = br#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>"#.to_vec();
        packet.extend(std::iter::repeat_n(b'x', fill));
        packet.extend_from_slice(br#"<?xpacket end="w"?>"#);
        packet
    }

    /// JPEG + APP1 占位包 + 若干 ExtendedXMP 分片（APP1，每片 60KB）；
    /// `corrupt` 翻转分片数据一字节，使 MD5 校验失败。
    pub(crate) fn jpeg_extended(packet: &[u8], corrupt: bool) -> Vec<u8> {
        let digest = md5_hex(packet);
        let mut bytes = base_jpeg();
        let placeholder =
            br#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><!-- placeholder --><?xpacket end="w"?>"#;
        let mut segments = Vec::new();
        let mut primary = XMP_HEADER.to_vec();
        primary.extend_from_slice(placeholder);
        segments.push(jpeg_segment(0xE1, &primary).unwrap());
        for (offset, chunk) in packet.chunks(60_000).enumerate() {
            let mut payload = XMP_EXT_SIGNATURE.to_vec();
            payload.extend_from_slice(&digest);
            payload.extend_from_slice(&(packet.len() as u32).to_be_bytes());
            payload.extend_from_slice(&((offset * 60_000) as u32).to_be_bytes());
            payload.extend_from_slice(chunk);
            segments.push(jpeg_segment(0xE1, &payload).unwrap());
        }
        jpeg_insert_after_app0(&mut bytes, &segments).unwrap();
        if corrupt {
            let signature_at = bytes
                .windows(XMP_EXT_SIGNATURE.len())
                .position(|window| window == XMP_EXT_SIGNATURE)
                .expect("应存在扩展分片");
            let data_at = signature_at + XMP_EXT_SIGNATURE.len() + 32 + 8;
            bytes[data_at] ^= 0xFF;
        }
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    const VENDOR_MARK: [u8; 8] = [0x5A, 0xC6, 0x12, 0xAA, 0x99, 0x37, 0x21, 0x08];

    #[test]
    fn jpeg_roundtrip_preserves_bytes_and_normalizes_orientation() {
        let source = extract(
            &jpeg_with(
                Some(&tiff_exif(6, 32, 24)),
                Some(&fake_icc()),
                Some(&known_xmp()),
            ),
            Kind::Jpeg,
        );
        assert!(source.exif_tiff.is_some());
        assert!(source.icc_raw.is_some());
        assert_eq!(source.xmp.len(), 1);
        let mut encoded = base_jpeg();
        let carried = carry_into(&mut encoded, Kind::Jpeg, &source, true, 6, (32, 24)).unwrap();
        verify(&encoded, Kind::Jpeg, &carried).unwrap();
        let out = extract(&encoded, Kind::Jpeg);
        let patched = out.exif_tiff.unwrap();
        // 方向条目归一为 1，其余字节（含未知厂商标签的越界数据）原样保留。
        assert_eq!(orientation_of_tiff(&patched), 1);
        assert!(patched.windows(VENDOR_MARK.len()).any(|w| w == VENDOR_MARK));
        assert!(patched
            .windows(b"Chunjun Test Camera".len())
            .any(|w| w == b"Chunjun Test Camera"));
        assert_eq!(out.icc_raw.unwrap(), fake_icc());
        assert_eq!(out.xmp, vec![known_xmp()]);
        assert_eq!(carried.exif_fields, 6);
    }

    #[test]
    fn orientation_stays_verbatim_when_pixels_were_not_rotated() {
        let bytes = jpeg_with(Some(&tiff_exif(6, 32, 24)), None, None);
        let source = extract(&bytes, Kind::Jpeg);
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();
        // 观察方向为 1（解码未旋正）时载荷必须逐字节保留，避免丢失从未烘焙的旋转。
        assert_eq!(extract(&encoded, Kind::Png).exif_tiff, source.exif_tiff);
    }

    #[test]
    fn jpeg_to_png_maps_containers() {
        let source = extract(
            &jpeg_with(
                Some(&tiff_exif(1, 32, 24)),
                Some(&fake_icc()),
                Some(&known_xmp()),
            ),
            Kind::Jpeg,
        );
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();
        let out = extract(&encoded, Kind::Png);
        assert!(out.exif_tiff.is_some());
        assert_eq!(out.icc_raw, Some(fake_icc()));
        assert_eq!(out.xmp, vec![known_xmp()]);
    }

    #[test]
    fn png_to_png_copies_chunks_verbatim() {
        let bytes = png_with(
            Some(&tiff_exif(1, 32, 24)),
            Some(&fake_icc()),
            Some(&known_xmp()),
            Some((b"gAMA", b"\x00\x00\x80\x9a")),
        );
        let source = extract(&bytes, Kind::Png);
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();
        for chunk in &source.png_chunks {
            assert!(
                encoded.windows(chunk.len()).any(|w| w == chunk),
                "PNG 块必须逐字节复用"
            );
        }
        if let Some(verbatim) = &source.icc_png_chunk {
            assert!(encoded.windows(verbatim.len()).any(|w| w == verbatim));
        }
    }

    #[test]
    fn png_to_jpeg_lists_what_it_cannot_carry() {
        let bytes = png_with(
            None,
            None,
            None,
            Some((b"tEXt", b"Comment\0shot on test bench")),
        );
        let source = extract(&bytes, Kind::Png);
        let list = uncarrivable(&source, Kind::Jpeg, true);
        assert!(list.iter().any(|item| item.contains("PNG 文本字段")));
        assert!(uncarrivable(&source, Kind::Png, true).is_empty());
    }

    #[test]
    fn webp_source_exif_maps_with_or_without_prefix() {
        for with_prefix in [false, true] {
            let bytes = webp_with(Some(&tiff_exif(1, 32, 24)), with_prefix);
            let source = extract(&bytes, Kind::Webp);
            let tiff = source.exif_tiff.clone().expect("WebP EXIF 应被提取");
            let mut encoded = base_png();
            let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
            verify(&encoded, Kind::Png, &carried).unwrap();
            assert_eq!(extract(&encoded, Kind::Png).exif_tiff, Some(tiff));
        }
    }

    #[test]
    fn broken_icc_sequence_is_reported_not_dropped_silently() {
        let mut bytes = base_jpeg();
        let mut payload = ICC_MARKER.to_vec();
        payload.extend_from_slice(&[2, 2]); // 序号从 2 开始：拼不出完整档案
        payload.extend_from_slice(&fake_icc());
        let segment = jpeg_segment(0xE2, &payload).unwrap();
        jpeg_insert_after_app0(&mut bytes, &[segment]).unwrap();
        let source = extract(&bytes, Kind::Jpeg);
        assert!(source.icc_broken);
        assert!(source.icc_raw.is_none());
        assert!(uncarrivable(&source, Kind::Png, true)
            .iter()
            .any(|item| item.contains("不完整的 ICC")));
    }

    #[test]
    fn duplicate_exif_is_not_silently_merged() {
        let tiff = tiff_exif(1, 32, 24);
        let mut bytes = jpeg_with(Some(&tiff), None, None);
        let mut payload = EXIF_HEADER.to_vec();
        payload.extend_from_slice(&tiff);
        let segment = jpeg_segment(0xE1, &payload).unwrap();
        jpeg_insert_after_app0(&mut bytes, &[segment]).unwrap();
        let source = extract(&bytes, Kind::Jpeg);
        assert!(source.duplicate_exif);
        assert!(uncarrivable(&source, Kind::Png, true)
            .iter()
            .any(|item| item.contains("重复的 EXIF")));
    }

    #[test]
    fn dimension_entries_follow_the_final_image() {
        let bytes = jpeg_with(Some(&tiff_exif(1, 32, 24)), None, None);
        let source = extract(&bytes, Kind::Jpeg);
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (16, 12)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();
        let patched = extract(&encoded, Kind::Png).exif_tiff.unwrap();
        let big_endian = tiff_order(&patched).unwrap();
        let ifd0 = tiff_u32(&patched, big_endian, 4).unwrap() as usize;
        let (start, count) = ifd_entries(&patched, big_endian, ifd0).unwrap();
        let mut sub = None;
        let mut dims = (0u32, 0u32);
        for index in 0..count {
            if let Some((tag, field_type, value_count, at)) =
                ifd_entry(&patched, big_endian, start, index)
            {
                if tag == 0x8769 && inline_single(field_type, value_count) {
                    sub = Some(tiff_u32(&patched, big_endian, at).unwrap() as usize);
                }
            }
        }
        let (sub_start, sub_count) = ifd_entries(&patched, big_endian, sub.unwrap()).unwrap();
        for index in 0..sub_count {
            if let Some((tag, 4, 1, at)) = ifd_entry(&patched, big_endian, sub_start, index) {
                if tag == 0xA002 {
                    dims.0 = tiff_u32(&patched, big_endian, at).unwrap();
                } else if tag == 0xA003 {
                    dims.1 = tiff_u32(&patched, big_endian, at).unwrap();
                }
            }
        }
        assert_eq!(dims, (16, 12));
    }

    #[test]
    fn verify_rejects_a_tampered_migration() {
        let source = extract(&jpeg_with(None, Some(&fake_icc()), None), Kind::Jpeg);
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        // 破坏 iCCP 压缩流中的一个字节（keyword\0 + 方法字节之后），复检必须失败。
        let position = encoded
            .windows(4)
            .position(|w| w == b"iCCP")
            .expect("应存在 iCCP 块");
        encoded[position + 8 + b"ICC profile\0".len() + 1] ^= 0xFF;
        assert!(verify(&encoded, Kind::Png, &carried).is_err());
    }

    #[test]
    fn c2pa_clue_is_detected_but_never_carried() {
        // 注释段（COM）里的 c2pa 线索不属于任何可迁移容器，重编码后不应出现。
        let mut bytes = base_jpeg();
        let segment = jpeg_segment(0xFE, b"c2pa clue in comment segment").unwrap();
        jpeg_insert_after_app0(&mut bytes, &[segment]).unwrap();
        let source = extract(&bytes, Kind::Jpeg);
        assert!(source.c2pa_clue);
        assert!(!source.has_carriable());
        let mut encoded = base_png();
        carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        assert!(!encoded.windows(4).any(|w| w == b"c2pa"));
    }

    fn hex(digest: [u8; 16]) -> String {
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn md5_matches_rfc1321_test_vectors() {
        assert_eq!(hex(md5(b"")), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(hex(md5(b"abc")), "900150983cd24fb0d6963f7d28e17f72");
        // RFC 1321 A.5 的 80 字符用例：跨两个 64 字节块。
        assert_eq!(
            hex(md5(
                b"12345678901234567890123456789012345678901234567890123456789012345678901234567890"
            )),
            "57edf4a22be3c955ac49da2e2107b67a"
        );
    }

    fn sub_ifd_dims(tiff: &[u8]) -> (u32, u32) {
        let big_endian = tiff_order(tiff).unwrap();
        let ifd0 = tiff_u32(tiff, big_endian, 4).unwrap() as usize;
        let (start, count) = ifd_entries(tiff, big_endian, ifd0).unwrap();
        let mut sub = None;
        for index in 0..count {
            if let Some((0x8769, field_type, 1, at)) = ifd_entry(tiff, big_endian, start, index) {
                if inline_single(field_type, 1) {
                    sub = Some(tiff_u32(tiff, big_endian, at).unwrap() as usize);
                }
            }
        }
        let (sub_start, sub_count) = ifd_entries(tiff, big_endian, sub.unwrap()).unwrap();
        let mut dims = (0, 0);
        for index in 0..sub_count {
            if let Some((tag, 4, 1, at)) = ifd_entry(tiff, big_endian, sub_start, index) {
                if tag == 0xA002 {
                    dims.0 = tiff_u32(tiff, big_endian, at).unwrap();
                } else if tag == 0xA003 {
                    dims.1 = tiff_u32(tiff, big_endian, at).unwrap();
                }
            }
        }
        dims
    }

    #[test]
    fn tiff_source_carries_ifd0_exif_icc_and_xmp() {
        let xmp = known_xmp();
        let bytes = tiff_source(6, Some(&xmp), Some(&fake_icc()), 8, false);
        let source = extract(&bytes, Kind::Tiff);
        assert!(!source.exif_unreadable);
        assert!(!source.tiff_layout_unsafe);
        assert!(source.exif_tiff.is_some());
        assert_eq!(source.icc_raw.as_deref(), Some(&fake_icc()[..]));
        assert_eq!(source.xmp, vec![xmp.clone()]);

        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 6, (24, 32)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();
        let out = extract(&encoded, Kind::Png);
        let patched = out.exif_tiff.expect("eXIf 应携带 IFD0 前缀");
        // 方向 6 已烘焙：载荷归一为 1，宽高跟随最终像素，厂商标签字节原样保留。
        assert_eq!(orientation_of_tiff(&patched), 1);
        assert_eq!(sub_ifd_dims(&patched), (24, 32));
        assert!(patched.windows(VENDOR_MARK.len()).any(|w| w == VENDOR_MARK));
        assert_eq!(out.icc_raw.as_deref(), Some(&fake_icc()[..]));
        assert_eq!(out.xmp, vec![xmp]);

        let mut encoded = base_jpeg();
        let carried = carry_into(&mut encoded, Kind::Jpeg, &source, true, 6, (24, 32)).unwrap();
        verify(&encoded, Kind::Jpeg, &carried).unwrap();
    }

    #[test]
    fn interleaved_tiff_layout_is_relocated_without_pixel_bytes() {
        let bytes = tiff_source(1, Some(&known_xmp()), None, 8, true);
        let source = extract(&bytes, Kind::Tiff);
        assert!(!source.tiff_layout_unsafe);
        let payload = source.exif_tiff.clone().expect("交错布局应重排迁移");
        // 重排载荷保留全部字段字节（含厂商标签），绝不夹带像素条带。
        assert!(payload.windows(VENDOR_MARK.len()).any(|w| w == VENDOR_MARK));
        assert!(
            !payload.windows(16).any(|w| w == [0xA5u8; 16]),
            "重排载荷不能包含像素字节"
        );
        assert!(payload.len() < bytes.len() - 700);
        assert_eq!(source.xmp.len(), 1, "按值取出的 XMP 仍可迁移");
        // 重排载荷本身是可解析的 TIFF，且能迁入 PNG 并复检。
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();
        let out = extract(&encoded, Kind::Png);
        let moved = out.exif_tiff.unwrap();
        assert!(moved.windows(VENDOR_MARK.len()).any(|w| w == VENDOR_MARK));
    }

    #[test]
    fn interleaved_tiff_with_maker_note_still_needs_explicit_consent() {
        let bytes = tiff_source_with_vendor(1, None, None, 8, true, 0x927C);
        let source = extract(&bytes, Kind::Tiff);
        // MakerNote 内部常用绝对偏移，重排可能破坏：保守要求确认。
        assert!(source.tiff_layout_unsafe);
        assert!(source.exif_tiff.is_none());
        assert!(uncarrivable(&source, Kind::Png, true)
            .iter()
            .any(|item| item.contains("交错")));
    }

    #[test]
    fn unreadable_tiff_exif_structure_is_reported_not_dropped() {
        // II*\0 但 IFD0 偏移越界：结构损坏必须上报，不能当没有元数据。
        let mut bytes = b"II*\0".to_vec();
        bytes.extend_from_slice(&8u16.to_le_bytes());
        bytes.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        let source = extract(&bytes, Kind::Tiff);
        assert!(source.exif_unreadable);
        assert!(source.exif_tiff.is_none());
        assert!(uncarrivable(&source, Kind::Png, true)
            .iter()
            .any(|item| item.contains("无法解析的 EXIF")));
    }

    #[test]
    fn gif_xmp_extension_block_is_reassembled_and_carried() {
        let packet = known_xmp(); // 超过 255 字节，必须跨子块重组
        assert!(packet.len() > 255);
        let bytes = gif_with(Some(&packet), false);
        let source = extract(&bytes, Kind::Gif);
        assert!(!source.xmp_broken);
        assert_eq!(source.xmp, vec![packet.clone()]);
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();
        assert_eq!(extract(&encoded, Kind::Png).xmp, vec![packet]);
    }

    #[test]
    fn truncated_gif_xmp_is_reported_not_guessed() {
        let bytes = gif_with(Some(&known_xmp()), true);
        let source = extract(&bytes, Kind::Gif);
        assert!(source.xmp_broken);
        assert!(source.xmp.is_empty());
        assert!(uncarrivable(&source, Kind::Png, true)
            .iter()
            .any(|item| item.contains("不完整的 XMP")));
    }

    #[test]
    fn svg_xpacket_is_extracted_and_carried_into_png() {
        let packet = known_xmp();
        let bytes = svg_with(Some(&packet));
        let source = extract(&bytes, Kind::Svg);
        assert_eq!(source.xmp, vec![packet.clone()]);
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();
        assert_eq!(extract(&encoded, Kind::Png).xmp, vec![packet]);
    }

    #[test]
    fn bmp_v5_embedded_icc_is_carried_and_linked_profile_is_listed() {
        let bytes = bmp_v5(Some(&fake_icc()), false);
        let source = extract(&bytes, Kind::Bmp);
        assert_eq!(source.icc_raw.as_deref(), Some(&fake_icc()[..]));
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();

        let source = extract(&bmp_v5(None, true), Kind::Bmp);
        assert!(source.icc_linked);
        assert!(source.icc_raw.is_none());
        assert!(uncarrivable(&source, Kind::Png, true)
            .iter()
            .any(|item| item.contains("外链的 ICC")));
    }

    #[test]
    fn extended_xmp_is_reassembled_with_md5_verification() {
        let packet = long_xpacket(90_000);
        assert!(packet.len() > 65_504, "用例必须覆盖超过单段上限的包");
        let bytes = jpeg_extended(&packet, false);
        let source = extract(&bytes, Kind::Jpeg);
        assert!(!source.xmp_broken);
        assert_eq!(source.xmp, vec![packet.clone()]);
        // JPEG 目标装不下整包：必须逐项列出，确认后丢弃而不是硬错误。
        assert!(uncarrivable(&source, Kind::Jpeg, true)
            .iter()
            .any(|item| item.contains("超过 JPEG 单段上限的 XMP")));
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();
        assert_eq!(extract(&encoded, Kind::Png).xmp, vec![packet]);
        // 确认丢弃后仍能导出 JPEG 副本，且不再写入任何 XMP。
        let mut encoded = base_jpeg();
        let carried = carry_into(&mut encoded, Kind::Jpeg, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Jpeg, &carried).unwrap();
        assert!(extract(&encoded, Kind::Jpeg).xmp.is_empty());
    }

    #[test]
    fn extended_xmp_with_bad_md5_is_flagged_broken() {
        let packet = long_xpacket(90_000);
        let bytes = jpeg_extended(&packet, true);
        let source = extract(&bytes, Kind::Jpeg);
        assert!(source.xmp_broken);
        assert!(source.xmp.is_empty());
        assert!(uncarrivable(&source, Kind::Png, true)
            .iter()
            .any(|item| item.contains("不完整的 XMP")));
    }

    #[test]
    fn oversized_tiff_exif_to_jpeg_is_listed_and_skipped() {
        let bytes = tiff_source(1, None, None, 70_000, false);
        let source = extract(&bytes, Kind::Tiff);
        assert!(source.exif_tiff.as_ref().unwrap().len() > 65_533);
        assert!(uncarrivable(&source, Kind::Jpeg, true)
            .iter()
            .any(|item| item.contains("超过 JPEG 单段上限的 EXIF")));
        // 确认丢弃后导出不再硬错误，复检通过；PNG 目标不受单段限制。
        let mut encoded = base_jpeg();
        let carried = carry_into(&mut encoded, Kind::Jpeg, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Jpeg, &carried).unwrap();
        assert!(extract(&encoded, Kind::Jpeg).exif_tiff.is_none());
        let mut encoded = base_png();
        let carried = carry_into(&mut encoded, Kind::Png, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Png, &carried).unwrap();
        assert!(extract(&encoded, Kind::Png).exif_tiff.is_some());
    }

    #[test]
    fn oversized_png_xmp_to_jpeg_requires_confirmation_instead_of_failing() {
        let packet = long_xpacket(70_000);
        let bytes = png_with(None, None, Some(&packet), None);
        let source = extract(&bytes, Kind::Png);
        assert!(uncarrivable(&source, Kind::Jpeg, true)
            .iter()
            .any(|item| item.contains("超过 JPEG 单段上限的 XMP")));
        let mut encoded = base_jpeg();
        let carried = carry_into(&mut encoded, Kind::Jpeg, &source, true, 1, (32, 24)).unwrap();
        verify(&encoded, Kind::Jpeg, &carried).unwrap();
        assert!(extract(&encoded, Kind::Jpeg).xmp.is_empty());
    }
}
