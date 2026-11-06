use std::io::Cursor;

use exif::{In, Reader, Tag};

use crate::model::{AigcFields, C2paStatus, Evidence, Kind};

const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const CHUNJUN_PRODUCER: &str = "纯钧";

#[derive(Debug, Clone)]
pub struct MetaEdit {
    pub policy: String,
    pub author: String,
    pub copyright: String,
    pub description: String,
    pub aigc_label: String,
    /// 声明主体；空字符串表示写纯钧自己的本地声明。
    pub producer: String,
    pub delete_fields: Vec<String>,
}

pub fn read_evidence(bytes: &[u8]) -> Evidence {
    let mut notes = Vec::new();
    let orientation = read_orientation(bytes);
    let software = read_software(bytes);
    let mut auxiliary = Vec::new();
    if let Some(software) = software {
        auxiliary.push(format!("Software：{software}"));
        notes.push("Software 只是辅助字段，不能单独证明图片由 AI 生成。".into());
    }
    let aigc = find_aigc(bytes);
    let copyright = find_text_tag(bytes, "dc:rights").unwrap_or_default();
    if aigc.is_none() {
        notes.push("未发现 AIGC 声明。未发现不等于非 AI，也不能当成人工创作。".into());
    }
    let c2pa_present = bytes.windows(4).any(|window| window == b"c2pa");
    let c2pa = if c2pa_present {
        notes.push(
            "检测到 c2pa 字节线索，尚未解析为有效容器。本版不做签名校验，也不查询远程撤销。".into(),
        );
        C2paStatus {
            present: true,
            signature: "未验证".into(),
            trust: "未建立".into(),
            remote: "未验证".into(),
        }
    } else {
        C2paStatus {
            present: false,
            signature: "未发现".into(),
            trust: "未发现".into(),
            remote: "未验证".into(),
        }
    };
    let containers = crate::migration::extract(bytes, crate::migration::sniff_kind(bytes));
    let icc = if containers.icc_raw.is_some() || containers.icc_png_chunk.is_some() {
        "存在".into()
    } else {
        "未发现".into()
    };
    let has_text_chunks = containers
        .png_chunks
        .iter()
        .any(|chunk| matches!(&chunk[4..8], b"tEXt" | b"zTXt" | b"iTXt"));
    let has_color_chunks = containers
        .png_chunks
        .iter()
        .any(|chunk| matches!(&chunk[4..8], b"gAMA" | b"cHRM" | b"sRGB" | b"cICP"));
    Evidence {
        aigc,
        auxiliary,
        c2pa,
        icc,
        orientation,
        copyright,
        notes,
        exif_fields: containers
            .exif_tiff
            .as_deref()
            .map(crate::migration::exif_field_count)
            .unwrap_or(0) as u32,
        has_xmp: !containers.xmp.is_empty(),
        has_text_chunks,
        has_color_chunks,
    }
}

pub fn apply_metadata(bytes: &[u8], kind: Kind, edit: &MetaEdit) -> Result<Vec<u8>, String> {
    if edit.policy == "keep" {
        return Ok(bytes.to_vec());
    }
    let mut evidence = read_evidence(bytes);
    let mut aigc = evidence.aigc.take();
    let mut copyright = evidence.copyright.clone();
    let mut author = find_text_tag(bytes, "dc:creator").unwrap_or_default();
    let mut description = find_text_tag(bytes, "dc:description").unwrap_or_default();
    let known_packet = xmp_packet(aigc.as_ref(), &author, &copyright, &description);
    ensure_known_xmp(bytes, kind, known_packet.as_bytes())?;
    match edit.policy.as_str() {
        "addAigc" => {
            let mut next = aigc.unwrap_or_else(empty_aigc);
            fill_missing_declaration(&mut next, &edit.aigc_label, producer_name(edit));
            aigc = Some(next);
        }
        "replaceAigc" => {
            aigc = Some(declared_aigc(&edit.aigc_label, producer_name(edit)));
        }
        "deleteFields" => {
            let Some(current) = aigc.as_mut() else {
                return Err("没有可删除的 AIGC 声明".into());
            };
            if edit.delete_fields.is_empty() {
                return Err("请选择要删除的声明字段".into());
            }
            for field in &edit.delete_fields {
                clear_field(current, field)?;
            }
            if current.is_empty() {
                aigc = None;
            }
        }
        "addGeneric" => {
            if !edit.author.trim().is_empty() {
                author = edit.author.trim().to_string();
            }
            if !edit.copyright.trim().is_empty() {
                copyright = edit.copyright.trim().to_string();
            }
            if !edit.description.trim().is_empty() {
                description = edit.description.trim().to_string();
            }
            if author.is_empty() && copyright.is_empty() && description.is_empty() {
                return Err("通用声明至少需要作者、版权或说明中的一项".into());
            }
        }
        _ => return Err("元数据策略无效".into()),
    }
    let packet = xmp_packet(aigc.as_ref(), &author, &copyright, &description);
    match kind {
        Kind::Jpeg => inject_jpeg_xmp(bytes, packet.as_bytes()),
        Kind::Png => inject_png_text(bytes, packet.as_bytes()),
        _ => Err("该格式不能嵌入元数据声明，请改用 JPEG 或 PNG".into()),
    }
}

fn ensure_known_xmp(bytes: &[u8], kind: Kind, expected: &[u8]) -> Result<(), String> {
    let unknown = || {
        "原文件包含尚不能完整保留的 XMP 字段（可能是多份或未知的声明副本），已拒绝改写，避免删除未选择的信息。"
            .to_string()
    };
    if kind == Kind::Jpeg {
        let mut index = 2usize;
        while index + 4 <= bytes.len() && bytes[index] == 0xff {
            let marker = bytes[index + 1];
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            let size = u16::from_be_bytes([bytes[index + 2], bytes[index + 3]]) as usize;
            let next = index + 2 + size;
            if size < 2 || next > bytes.len() {
                return Err(unknown());
            }
            let data = &bytes[index + 4..next];
            if marker == 0xe1
                && data.starts_with(XMP_HEADER)
                && &data[XMP_HEADER.len()..] != expected
            {
                return Err(unknown());
            }
            index = next;
        }
    } else if kind == Kind::Png {
        let mut index = 8usize;
        while index + 12 <= bytes.len() {
            let size = u32::from_be_bytes(bytes[index..index + 4].try_into().unwrap()) as usize;
            let next = index
                .checked_add(12)
                .and_then(|value| value.checked_add(size))
                .ok_or_else(unknown)?;
            if next > bytes.len() {
                return Err(unknown());
            }
            let chunk = &bytes[index + 4..index + 8];
            let data = &bytes[index + 8..index + 8 + size];
            if matches!(chunk, b"iTXt" | b"tEXt" | b"zTXt")
                && data.starts_with(b"XML:com.adobe.xmp\0")
            {
                let prefix: &[u8] = if chunk == b"iTXt" {
                    b"XML:com.adobe.xmp\0\0\0\0\0"
                } else if chunk == b"tEXt" {
                    b"XML:com.adobe.xmp\0"
                } else {
                    return Err(unknown());
                };
                if !data.starts_with(prefix) || &data[prefix.len()..] != expected {
                    return Err(unknown());
                }
            }
            index = next;
        }
    } else {
        // TIFF（0x02BC）、GIF（XMP 扩展块）、SVG（xpacket）与 JPEG 的 ExtendedXMP：
        // 从迁移提取器取重组后的包，逐包与已知声明比对，未知的拒绝改写。
        let packets = crate::migration::extract(bytes, kind).xmp;
        if packets.iter().any(|packet| packet.as_slice() != expected) {
            return Err(unknown());
        }
    }
    Ok(())
}

fn empty_aigc() -> AigcFields {
    AigcFields {
        label: String::new(),
        content_producer: String::new(),
        produce_id: String::new(),
        reserved_code1: String::new(),
        content_propagator: String::new(),
        propagate_id: String::new(),
        reserved_code2: String::new(),
    }
}

fn producer_name(edit: &MetaEdit) -> &str {
    let name = edit.producer.trim();
    if name.is_empty() {
        CHUNJUN_PRODUCER
    } else {
        name
    }
}

fn declared_aigc(label: &str, producer: &str) -> AigcFields {
    AigcFields {
        label: label.to_string(),
        content_producer: producer.to_string(),
        produce_id: local_id("produce"),
        reserved_code1: String::new(),
        content_propagator: producer.to_string(),
        propagate_id: local_id("propagate"),
        reserved_code2: String::new(),
    }
}

fn fill_missing_declaration(fields: &mut AigcFields, label: &str, producer: &str) {
    if fields.label.is_empty() {
        fields.label = label.to_string();
    }
    if fields.content_producer.is_empty() {
        fields.content_producer = producer.to_string();
    }
    if fields.produce_id.is_empty() {
        fields.produce_id = local_id("produce");
    }
    if fields.content_propagator.is_empty() {
        fields.content_propagator = producer.to_string();
    }
    if fields.propagate_id.is_empty() {
        fields.propagate_id = local_id("propagate");
    }
}

fn local_id(role: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("chunjun-{role}-{millis}")
}

fn clear_field(fields: &mut AigcFields, name: &str) -> Result<(), String> {
    let slot = match name {
        "Label" => &mut fields.label,
        "ContentProducer" => &mut fields.content_producer,
        "ProduceID" => &mut fields.produce_id,
        "ReservedCode1" => &mut fields.reserved_code1,
        "ContentPropagator" => &mut fields.content_propagator,
        "PropagateID" => &mut fields.propagate_id,
        "ReservedCode2" => &mut fields.reserved_code2,
        _ => return Err(format!("未知声明字段：{name}")),
    };
    slot.clear();
    Ok(())
}

fn xmp_packet(
    aigc: Option<&AigcFields>,
    author: &str,
    copyright: &str,
    description: &str,
) -> String {
    let mut body = String::new();
    if !author.is_empty() {
        body.push_str(&format!(
            "<dc:creator>{text}</dc:creator>",
            text = xml_escape(author)
        ));
    }
    if !copyright.is_empty() {
        body.push_str(&format!(
            "<dc:rights>{text}</dc:rights>",
            text = xml_escape(copyright)
        ));
    }
    if !description.is_empty() {
        body.push_str(&format!(
            "<dc:description>{text}</dc:description>",
            text = xml_escape(description)
        ));
    }
    if let Some(fields) = aigc {
        body.push_str(&format!(
            "<AIGC:Label>{label}</AIGC:Label><AIGC:ContentProducer>{producer}</AIGC:ContentProducer><AIGC:ProduceID>{produce}</AIGC:ProduceID><AIGC:ReservedCode1>{code1}</AIGC:ReservedCode1><AIGC:ContentPropagator>{propagator}</AIGC:ContentPropagator><AIGC:PropagateID>{propagate}</AIGC:PropagateID><AIGC:ReservedCode2>{code2}</AIGC:ReservedCode2>",
            label = xml_escape(&fields.label),
            producer = xml_escape(&fields.content_producer),
            produce = xml_escape(&fields.produce_id),
            code1 = xml_escape(&fields.reserved_code1),
            propagator = xml_escape(&fields.content_propagator),
            propagate = xml_escape(&fields.propagate_id),
            code2 = xml_escape(&fields.reserved_code2),
        ));
    }
    format!(
        "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:AIGC=\"http://www.tc260.org.cn/ns/AIGC/1.0/\"><rdf:Description rdf:about=\"\">{body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn find_aigc(bytes: &[u8]) -> Option<AigcFields> {
    let text = String::from_utf8_lossy(bytes);
    if let Some(fields) = aigc_from_json(&text) {
        return Some(fields);
    }
    let label = xml_value(&text, "AIGC:Label");
    let producer = xml_value(&text, "AIGC:ContentProducer");
    if label.is_none() && producer.is_none() {
        return None;
    }
    Some(AigcFields {
        label: label.unwrap_or_default(),
        content_producer: producer.unwrap_or_default(),
        produce_id: xml_value(&text, "AIGC:ProduceID").unwrap_or_default(),
        reserved_code1: xml_value(&text, "AIGC:ReservedCode1").unwrap_or_default(),
        content_propagator: xml_value(&text, "AIGC:ContentPropagator").unwrap_or_default(),
        propagate_id: xml_value(&text, "AIGC:PropagateID").unwrap_or_default(),
        reserved_code2: xml_value(&text, "AIGC:ReservedCode2").unwrap_or_default(),
    })
}

fn aigc_from_json(text: &str) -> Option<AigcFields> {
    let marker = text.find("\"ContentProducer\"")?;
    let start = text[..marker].rfind('{')?;
    let slice = &text[start..];
    let end = matching_brace(slice)?;
    let value: serde_json::Value = serde_json::from_str(&slice[..=end]).ok()?;
    let object = value.get("AIGC").unwrap_or(&value);
    let fields = AigcFields {
        label: json_string(object, "Label"),
        content_producer: json_string(object, "ContentProducer"),
        produce_id: json_string(object, "ProduceID"),
        reserved_code1: json_string(object, "ReservedCode1"),
        content_propagator: json_string(object, "ContentPropagator"),
        propagate_id: json_string(object, "PropagateID"),
        reserved_code2: json_string(object, "ReservedCode2"),
    };
    if fields.is_empty() {
        None
    } else {
        Some(fields)
    }
}

fn json_string(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_string()
}

fn matching_brace(slice: &str) -> Option<usize> {
    let mut depth = 0;
    let mut quote = false;
    let mut escape = false;
    for (index, ch) in slice.char_indices() {
        if quote {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                quote = false;
            }
            continue;
        }
        match ch {
            '"' => quote = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn xml_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(
        text[start..end]
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&"),
    )
}

fn find_text_tag(bytes: &[u8], tag: &str) -> Option<String> {
    xml_value(&String::from_utf8_lossy(bytes), tag)
}

pub(crate) fn read_orientation(bytes: &[u8]) -> u16 {
    let Ok(exif) = Reader::new().read_from_container(&mut Cursor::new(bytes)) else {
        return 1;
    };
    exif.get_field(Tag::Orientation, In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| (1..=8).contains(value))
        .unwrap_or(1)
}

fn read_software(bytes: &[u8]) -> Option<String> {
    let exif = Reader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok()?;
    let field = exif.get_field(Tag::Software, In::PRIMARY)?;
    let text = field.display_value().to_string();
    let trimmed = text.trim().trim_matches('"').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// 重编码并改写声明前，对源文件执行与元数据页一致的未知 XMP 门禁：
/// 已知包允许编辑，未知或多份包拒绝，防止重编码顺手抹掉未理解的声明。
pub(crate) fn ensure_editable_xmp(bytes: &[u8], kind: Kind) -> Result<(), String> {
    let mut evidence = read_evidence(bytes);
    let aigc = evidence.aigc.take();
    let author = find_text_tag(bytes, "dc:creator").unwrap_or_default();
    let copyright = evidence.copyright.clone();
    let description = find_text_tag(bytes, "dc:description").unwrap_or_default();
    let packet = xmp_packet(aigc.as_ref(), &author, &copyright, &description);
    ensure_known_xmp(bytes, kind, packet.as_bytes())
}

fn inject_jpeg_xmp(bytes: &[u8], xmp: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err("不是 JPEG，无法写入声明".into());
    }
    let mut output = vec![0xFF, 0xD8];
    let mut index = 2;
    while index + 1 < bytes.len() && bytes[index] == 0xFF {
        let marker = bytes[index + 1];
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        if marker == 0x00 || (0xD0..=0xD8).contains(&marker) {
            output.push(0xFF);
            output.push(marker);
            index += 2;
            continue;
        }
        if index + 4 > bytes.len() {
            return Err("JPEG 段损坏".into());
        }
        let length = u16::from_be_bytes([bytes[index + 2], bytes[index + 3]]) as usize;
        let next = index + 2 + length;
        if length < 2 || next > bytes.len() {
            return Err("JPEG 段损坏".into());
        }
        let segment = &bytes[index..next];
        let is_xmp = marker == 0xE1
            && segment.len() > 4 + XMP_HEADER.len()
            && &segment[4..4 + XMP_HEADER.len()] == XMP_HEADER;
        if !is_xmp {
            output.extend_from_slice(segment);
        }
        index = next;
    }
    let payload = XMP_HEADER.len() + xmp.len();
    let segment_length = payload + 2;
    if segment_length > u16::MAX as usize {
        return Err("声明内容过长".into());
    }
    output.push(0xFF);
    output.push(0xE1);
    output.extend_from_slice(&(segment_length as u16).to_be_bytes());
    output.extend_from_slice(XMP_HEADER);
    output.extend_from_slice(xmp);
    output.extend_from_slice(&bytes[index..]);
    Ok(output)
}

fn inject_png_text(bytes: &[u8], xmp: &[u8]) -> Result<Vec<u8>, String> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(SIGNATURE) {
        return Err("不是 PNG，无法写入声明".into());
    }
    let mut chunks = Vec::new();
    let mut index = SIGNATURE.len();
    while index + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes[index..index + 4].try_into().unwrap()) as usize;
        let kind = &bytes[index + 4..index + 8];
        let next = index + 12 + length;
        if next > bytes.len() {
            return Err("PNG 块损坏".into());
        }
        let data = &bytes[index + 8..index + 8 + length];
        let drop = matches!(kind, b"iTXt" | b"tEXt" | b"zTXt")
            && (data.starts_with(b"AIGC\0") || data.starts_with(b"XML:com.adobe.xmp\0"));
        if kind != b"IEND" && !drop {
            chunks.push(bytes[index..next].to_vec());
        }
        if kind == b"IEND" {
            break;
        }
        index = next;
    }
    let mut text = Vec::new();
    text.extend_from_slice(b"XML:com.adobe.xmp\0");
    text.push(0);
    text.push(0);
    text.extend_from_slice(b"\0\0");
    text.extend_from_slice(xmp);
    chunks.push(png_chunk(b"iTXt", &text));
    chunks.push(png_chunk(b"IEND", &[]));
    let mut output = SIGNATURE.to_vec();
    for chunk in chunks {
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

pub(crate) fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut chunk = Vec::with_capacity(12 + data.len());
    chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
    chunk.extend_from_slice(kind);
    chunk.extend_from_slice(data);
    let mut crc_data = kind.to_vec();
    crc_data.extend_from_slice(data);
    let crc = crc32fast::hash(&crc_data);
    chunk.extend_from_slice(&crc.to_be_bytes());
    chunk
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generic_edit() -> MetaEdit {
        MetaEdit {
            policy: "addGeneric".into(),
            author: "作者 & 合作方".into(),
            copyright: "版权".into(),
            description: "说明".into(),
            aigc_label: "1".into(),
            producer: String::new(),
            delete_fields: vec![],
        }
    }

    #[test]
    fn changing_aigc_keeps_unselected_generic_fields() {
        let bytes = apply_metadata(&sample_png(), Kind::Png, &generic_edit()).unwrap();
        let edit = MetaEdit {
            policy: "addAigc".into(),
            ..generic_edit()
        };
        let updated = apply_metadata(&bytes, Kind::Png, &edit).unwrap();
        assert_eq!(
            find_text_tag(&updated, "dc:creator").as_deref(),
            Some("作者 & 合作方")
        );
        assert_eq!(
            find_text_tag(&updated, "dc:description").as_deref(),
            Some("说明")
        );
        assert!(read_evidence(&updated).aigc.is_some());
    }

    #[test]
    fn unknown_xmp_is_rejected_instead_of_erased() {
        let xmp = xmp_packet(None, "", "", "").replace(
            "</rdf:Description>",
            "<dc:subject>保留标签</dc:subject></rdf:Description>",
        );
        let bytes = inject_png_text(&sample_png(), xmp.as_bytes()).unwrap();
        assert!(apply_metadata(&bytes, Kind::Png, &generic_edit())
            .unwrap_err()
            .contains("XMP"));
    }

    #[test]
    fn a_known_packet_does_not_authorize_erasing_an_unknown_second_packet() {
        let bytes = apply_metadata(&sample_png(), Kind::Png, &generic_edit()).unwrap();
        let mut data = b"XML:com.adobe.xmp\0\0\0\0\0".to_vec();
        data.extend_from_slice("<unknown>保留</unknown>".as_bytes());
        let mut mixed = bytes[..bytes.len() - 12].to_vec();
        mixed.extend(png_chunk(b"iTXt", &data));
        mixed.extend_from_slice(&bytes[bytes.len() - 12..]);
        assert!(apply_metadata(&mixed, Kind::Png, &generic_edit()).is_err());
    }

    #[test]
    fn unknown_xmp_in_tiff_gif_and_svg_sources_blocks_rewriting() {
        use crate::migration::fixtures;
        let packet = fixtures::known_xmp();
        let tiff = fixtures::tiff_source(1, Some(&packet), None, 8, false);
        assert!(ensure_editable_xmp(&tiff, Kind::Tiff).is_err());
        let gif = fixtures::gif_with(Some(&packet), false);
        assert!(ensure_editable_xmp(&gif, Kind::Gif).is_err());
        let svg = fixtures::svg_with(Some(&packet));
        assert!(ensure_editable_xmp(&svg, Kind::Svg).is_err());
        // 没有 XMP 的源不受影响。
        assert!(
            ensure_editable_xmp(&fixtures::tiff_source(1, None, None, 8, false), Kind::Tiff)
                .is_ok()
        );
        assert!(ensure_editable_xmp(&fixtures::gif_with(None, false), Kind::Gif).is_ok());
    }

    #[test]
    fn raw_c2pa_text_is_only_an_unverified_clue() {
        let evidence = read_evidence(b"text c2pa text");
        assert!(evidence.c2pa.present);
        assert_eq!(evidence.c2pa.signature, "未验证");
        assert!(evidence.notes.iter().any(|note| note.contains("字节线索")));
        assert!(!evidence
            .notes
            .iter()
            .any(|note| note.contains("已发现 C2PA 容器")));
    }
    use image::{ImageBuffer, Rgb};

    fn sample_jpeg() -> Vec<u8> {
        let image: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(8, 6, Rgb([20, 40, 60]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        bytes
    }

    fn sample_png() -> Vec<u8> {
        let image: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(8, 6, Rgb([20, 40, 60]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }

    #[test]
    fn metadata_roundtrip_keeps_jpeg_pixels_and_reads_chunjun_id() {
        let original = sample_jpeg();
        let edited = apply_metadata(
            &original,
            Kind::Jpeg,
            &MetaEdit {
                policy: "addAigc".into(),
                author: String::new(),
                copyright: String::new(),
                description: String::new(),
                aigc_label: "1".into(),
                producer: String::new(),
                delete_fields: Vec::new(),
            },
        )
        .unwrap();
        let before = image::load_from_memory(&original).unwrap().to_rgb8();
        let after = image::load_from_memory(&edited).unwrap().to_rgb8();
        assert_eq!(before.into_raw(), after.into_raw());
        let evidence = read_evidence(&edited);
        let aigc = evidence.aigc.expect("声明应被读回");
        assert_eq!(aigc.content_producer, "纯钧");
        assert!(aigc.produce_id.starts_with("chunjun-"));
        assert_ne!(aigc.produce_id, "厂商原始编号");
        assert_eq!(evidence.c2pa.signature, "未发现");
    }

    #[test]
    fn declared_platform_is_written_but_the_id_stays_local() {
        let original = sample_png();
        let edited = apply_metadata(
            &original,
            Kind::Png,
            &MetaEdit {
                policy: "replaceAigc".into(),
                author: String::new(),
                copyright: String::new(),
                description: String::new(),
                aigc_label: "1".into(),
                producer: "即梦/豆包".into(),
                delete_fields: Vec::new(),
            },
        )
        .unwrap();
        let aigc = read_evidence(&edited).aigc.expect("声明应被读回");
        assert_eq!(aigc.content_producer, "即梦/豆包");
        assert_eq!(aigc.content_propagator, "即梦/豆包");
        assert!(aigc.produce_id.starts_with("chunjun-"));
        assert!(aigc.propagate_id.starts_with("chunjun-"));
    }

    #[test]
    fn deleting_a_field_keeps_png_pixels() {
        let original = sample_png();
        let added = apply_metadata(
            &original,
            Kind::Png,
            &MetaEdit {
                policy: "replaceAigc".into(),
                author: String::new(),
                copyright: String::new(),
                description: String::new(),
                aigc_label: "2".into(),
                producer: String::new(),
                delete_fields: Vec::new(),
            },
        )
        .unwrap();
        let deleted = apply_metadata(
            &added,
            Kind::Png,
            &MetaEdit {
                policy: "deleteFields".into(),
                author: String::new(),
                copyright: String::new(),
                description: String::new(),
                aigc_label: "1".into(),
                producer: String::new(),
                delete_fields: vec!["ProduceID".into()],
            },
        )
        .unwrap();
        let before = image::load_from_memory(&original).unwrap().to_rgb8();
        let after = image::load_from_memory(&deleted).unwrap().to_rgb8();
        assert_eq!(before.into_raw(), after.into_raw());
        let evidence = read_evidence(&deleted);
        assert!(evidence.aigc.unwrap().produce_id.is_empty());
    }

    #[test]
    fn missing_declaration_is_not_called_human() {
        let evidence = read_evidence(&sample_jpeg());
        assert!(evidence.aigc.is_none());
        assert!(evidence
            .notes
            .iter()
            .any(|note| note.contains("不等于非 AI")));
    }
}
