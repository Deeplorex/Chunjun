use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// 编码可并发；命名与落盘必须作为一个事务，防止同名任务互相覆盖。
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static TEMP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

use crate::grant::{self, Conflict};
use crate::image_ops;
use crate::model::{Edit, ExportItem, Kind};

pub struct ExportRequest {
    pub source: PathBuf,
    pub source_name: String,
    pub source_kind: Kind,
    pub output_dir: PathBuf,
    pub edit: Edit,
    pub mark: Option<Vec<u8>>,
    pub protected_sources: Vec<PathBuf>,
}

pub fn export_file_with_progress(
    request: ExportRequest,
    stage: image_ops::Stage<'_>,
) -> ExportItem {
    let id_name = request.source_name.clone();
    match export_inner(request, stage) {
        Ok(item) => item,
        Err(message) => ExportItem {
            id: String::new(),
            name: id_name,
            state: "failed".into(),
            message,
            output_name: String::new(),
            output_path: String::new(),
            bytes: 0,
            source_bytes: 0,
            saved_bytes: 0,
        },
    }
}

fn export_inner(request: ExportRequest, stage: image_ops::Stage<'_>) -> Result<ExportItem, String> {
    stage("读取源文件", 0.04);
    // 导入时已拒绝链接并规范化路径；导出前复查文件与其各级父目录，防止导入后
    // 被外部替换为链接或装载点，把读取重定向到别处。
    if passes_through_symlink(&request.source) {
        return Err("源文件或其所在目录在导入后变成了链接，已拒绝读取".into());
    }
    let source_bytes = fs::metadata(&request.source)
        .map_err(|_| "源文件已移动或无法读取".to_string())?
        .len();
    let original = fs::read(&request.source).map_err(|_| "源文件已移动或无法读取".to_string())?;
    fs::create_dir_all(&request.output_dir).map_err(|_| "无法创建导出目录".to_string())?;
    let stem = Path::new(&request.source_name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "图片".into());
    let processed = image_ops::process_with_stage(
        &original,
        &request.edit,
        request.source_kind,
        request.mark.as_deref(),
        &|name, fraction| stage(name, 0.05 + fraction * 0.8),
    )?;
    let conflict = Conflict::parse(&request.edit.conflict)?;
    stage("写入副本", 0.9);
    let _writing = WRITE_LOCK.lock().map_err(|_| "导出写入状态不可用")?;
    let planned = grant::plan_destination(
        &request.output_dir,
        &stem,
        processed.kind.extension(),
        &request.edit.prefix,
        &request.edit.suffix,
        &request.source,
        conflict,
    )?;
    if planned.skip {
        return Ok(ExportItem {
            id: String::new(),
            name: request.source_name,
            state: "skipped".into(),
            message: "已跳过同名文件，源文件未改动".into(),
            output_name: file_name(&planned.path),
            output_path: planned.path.to_string_lossy().to_string(),
            bytes: 0,
            source_bytes,
            saved_bytes: 0,
        });
    }
    if paths_same(&planned.path, &request.source)
        || request
            .protected_sources
            .iter()
            .any(|source| paths_same(&planned.path, source))
    {
        return Err("不能覆盖源文件".into());
    }
    write_copy(
        &planned.path,
        &processed.encoded,
        conflict == Conflict::Replace,
    )?;
    stage("回读校验", 0.96);
    let reread = fs::read(&planned.path).map_err(|_| "导出后无法回读".to_string())?;
    if reread != processed.encoded {
        return Err("回读字节与写出内容不一致".into());
    }
    let state = if processed.below_target {
        "below_target"
    } else {
        "success"
    };
    let saved = source_bytes as i64 - processed.encoded.len() as i64;
    Ok(ExportItem {
        id: String::new(),
        name: request.source_name,
        state: state.into(),
        message: if processed.message.is_empty() {
            "已写出副本并回读".into()
        } else {
            format!("{} 已回读。", processed.message)
        },
        output_name: file_name(&planned.path),
        output_path: planned.path.to_string_lossy().to_string(),
        bytes: processed.encoded.len() as u64,
        source_bytes,
        saved_bytes: saved,
    })
}

fn write_copy(destination: &Path, bytes: &[u8], replace: bool) -> Result<(), String> {
    let serial = TEMP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary =
        destination.with_extension(format!("{}.{}.partial", std::process::id(), serial));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "无法创建独占临时文件，请检查磁盘空间和权限".to_string())?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法写入临时文件，请检查磁盘空间和权限".to_string())?;
        drop(file);
        if replace {
            // rename 替换目录项；失败时保留旧副本，不先删除目标。
            fs::rename(&temporary, destination)
                .map_err(|_| "无法完成副本写入，目标可能已存在或不支持安全写入".to_string())
        } else {
            // 优先硬链接：目标目录项的创建是独占原子操作，外部抢占同名文件不会被覆盖。
            // 部分卷（FAT32、网络盘、部分可移动卷）不支持硬链接；回退为「独占创建 +
            // 写入 + 落盘」，仍然绝不覆盖已存在的目标。
            match fs::hard_link(&temporary, destination) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Err("目标文件已存在，不会覆盖".to_string())
                }
                Err(_) => publish_exclusive(destination, bytes),
            }
        }
    })();
    let _ = fs::remove_file(&temporary);
    result
}

/// 硬链接不可用时的回退：独占创建目标并写入同一份字节，完成后落盘。
fn publish_exclusive(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut target = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "目标文件已存在，不会覆盖".to_string()
            } else {
                "无法完成副本写入，请检查磁盘空间和权限".to_string()
            }
        })?;
    target
        .write_all(bytes)
        .and_then(|_| target.sync_all())
        .map_err(|_| "无法完成副本写入，请检查磁盘空间和权限".to_string())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn paths_same(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// 文件自身或任一父目录当前是否为符号链接/装载点（Windows junction 在
/// `symlink_metadata` 下同样表现为 symlink）。无法读取的祖先不视为链接。
fn passes_through_symlink(path: &Path) -> bool {
    path.ancestors().any(|ancestor| {
        fs::symlink_metadata(ancestor)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
    })
}

pub fn write_report(directory: &Path, items: &[ExportItem]) -> Result<(), String> {
    let report = serde_json::json!({
        "product": "纯钧",
        "note": "未发现声明不等于人工创作，也不等于非 AI。厂商名称只是适配目标，不是已验证支持。",
        "items": items.iter().map(|item| serde_json::json!({
            "name": item.name,
            "state": item.state,
            "message": item.message,
            "outputName": item.output_name,
            "bytes": item.bytes
        })).collect::<Vec<_>>()
    });
    let _writing = WRITE_LOCK.lock().map_err(|_| "报告写入状态不可用")?;
    let path = grant::plan_destination(
        directory,
        "纯钧来源报告",
        "json",
        "",
        "",
        Path::new(""),
        Conflict::Number,
    )?
    .path;
    write_copy(
        &path,
        &serde_json::to_vec_pretty(&report).map_err(|_| "无法生成报告")?,
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use std::io::Cursor;

    #[test]
    fn existing_partial_file_is_never_touched() {
        let dir = workspace();
        fs::create_dir_all(dir.join("纯钧导出")).unwrap();
        let partial = dir.join("纯钧导出/测试_纯钧.png.partial");
        fs::write(&partial, b"user data").unwrap();
        assert_eq!(run(&dir, "测试.png", Edit::default()).state, "success");
        assert_eq!(fs::read(partial).unwrap(), b"user data");
    }

    #[test]
    fn concurrent_same_names_produce_distinct_copies() {
        let dir = workspace();
        let source = dir.join("测试.png");
        fs::write(&source, png_bytes()).unwrap();
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        export_file_with_progress(
                            ExportRequest {
                                source: source.clone(),
                                source_name: "测试.png".into(),
                                source_kind: Kind::Png,
                                output_dir: dir.join("纯钧导出"),
                                edit: Edit::default(),
                                mark: None,
                                protected_sources: vec![],
                            },
                            &|name, _| {
                                if name == "写入副本" {
                                    barrier.wait();
                                }
                            },
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(
            results.iter().all(|item| item.state == "success"),
            "{results:?}"
        );
        assert_ne!(results[0].output_name, results[1].output_name);
    }

    #[test]
    fn report_never_overwrites_an_existing_file() {
        let dir = workspace();
        fs::write(dir.join("纯钧来源报告.json"), b"existing report").unwrap();
        write_report(&dir, &[]).unwrap();
        assert_eq!(
            fs::read(dir.join("纯钧来源报告.json")).unwrap(),
            b"existing report"
        );
        assert!(dir.join("纯钧来源报告-2.json").exists());
    }

    #[test]
    fn replacement_cannot_target_another_imported_source() {
        let dir = workspace();
        let source = dir.join("照片.png");
        let other = dir.join("照片_纯钧.png");
        fs::write(&source, png_bytes()).unwrap();
        fs::write(&other, b"other source").unwrap();
        let result = export_file_with_progress(
            ExportRequest {
                source,
                source_name: "照片.png".into(),
                source_kind: Kind::Png,
                output_dir: dir.clone(),
                edit: Edit {
                    conflict: "replace".into(),
                    ..Edit::default()
                },
                mark: None,
                protected_sources: vec![other.clone()],
            },
            &|_, _| {},
        );
        assert_eq!(result.state, "failed");
        assert_eq!(fs::read(other).unwrap(), b"other source");
    }

    #[test]
    fn exclusive_publish_never_overwrites_an_existing_target() {
        let dir = workspace();
        let target = dir.join("副本.png");
        fs::write(&target, b"old copy").unwrap();
        // 目标已存在：回退路径必须拒绝，旧副本保持原样。
        assert!(publish_exclusive(&target, b"new").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old copy");
        // 目标不存在：写入并落盘成功。
        let fresh = dir.join("新副本.png");
        publish_exclusive(&fresh, b"new copy").unwrap();
        assert_eq!(fs::read(&fresh).unwrap(), b"new copy");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn source_replaced_by_a_link_after_import_is_refused() {
        let dir = workspace();
        let real = dir.join("真图.png");
        let source = dir.join("照片.png");
        fs::write(&real, png_bytes()).unwrap();
        fs::write(&source, png_bytes()).unwrap();
        // 模拟导入后源文件被外部替换：删除原文件并在原路径创建符号链接。
        fs::remove_file(&source).unwrap();
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(&real, &source);
        #[cfg(not(windows))]
        let created = std::os::unix::fs::symlink(&real, &source);
        if created.is_ok() {
            let result = export_file_with_progress(
                ExportRequest {
                    source: source.clone(),
                    source_name: "照片.png".into(),
                    source_kind: Kind::Png,
                    output_dir: dir.join("纯钧导出"),
                    edit: Edit::default(),
                    mark: None,
                    protected_sources: vec![],
                },
                &|_, _| {},
            );
            assert_eq!(result.state, "failed");
            assert!(result.message.contains("链接"), "{}", result.message);
        } else {
            assert!(!fs::symlink_metadata(&source).is_ok(), "原文件应已删除");
        }
    }

    fn png_bytes() -> Vec<u8> {
        let image: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(64, 48, |x, y| Rgb([(x * 3) as u8, (y * 4) as u8, 90]));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    fn workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "chunjun-export-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn run(dir: &Path, name: &str, edit: Edit) -> ExportItem {
        let source = dir.join(name);
        fs::write(&source, png_bytes()).unwrap();
        export_file_with_progress(
            ExportRequest {
                source,
                source_name: name.into(),
                source_kind: Kind::Png,
                output_dir: dir.join("纯钧导出"),
                edit,
                mark: None,
                protected_sources: Vec::new(),
            },
            &|_, _| {},
        )
    }

    #[test]
    fn export_reports_read_write_and_verify_stages() {
        let dir = workspace();
        let source = dir.join("阶段 图片.png");
        fs::write(&source, png_bytes()).unwrap();
        let seen = std::cell::RefCell::new(Vec::new());
        export_file_with_progress(
            ExportRequest {
                source,
                source_name: "阶段 图片.png".into(),
                source_kind: Kind::Png,
                output_dir: dir.join("纯钧导出"),
                edit: Edit::default(),
                mark: None,
                protected_sources: Vec::new(),
            },
            &|name, fraction| {
                seen.borrow_mut().push((name.to_string(), fraction));
            },
        );
        let stages = seen.into_inner();
        let names: Vec<&str> = stages.iter().map(|pair| pair.0.as_str()).collect();
        assert!(names.contains(&"读取源文件"), "缺少读取阶段：{names:?}");
        assert!(names.contains(&"写入副本"), "缺少写入阶段：{names:?}");
        assert!(names.contains(&"回读校验"), "缺少校验阶段：{names:?}");
        assert!(
            stages.windows(2).all(|pair| pair[0].1 <= pair[1].1),
            "阶段进度不能倒退：{stages:?}"
        );
    }

    #[test]
    fn compresses_to_a_copy() {
        let dir = workspace();
        let item = run(
            &dir,
            "测试 图片.png",
            Edit {
                quality: 70,
                output_format: "jpeg".into(),
                suffix: "_纯钧".into(),
                ..Edit::default()
            },
        );
        assert_eq!(item.state, "success", "{}", item.message);
        assert_eq!(item.output_name, "测试 图片_纯钧.jpg");
        assert!(dir.join("纯钧导出").join(&item.output_name).exists());
    }

    #[test]
    fn converts_format_and_crops() {
        let dir = workspace();
        let item = run(
            &dir,
            "crop.png",
            Edit {
                output_format: "webp".into(),
                use_crop: true,
                crop_x: 0,
                crop_y: 0,
                crop_w: 32,
                crop_h: 24,
                ..Edit::default()
            },
        );
        assert_eq!(item.state, "success", "{}", item.message);
        let bytes = fs::read(dir.join("纯钧导出").join(&item.output_name)).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (32, 24));
    }

    #[test]
    fn exported_copy_keeps_migrated_metadata_on_disk() {
        let dir = workspace();
        let source = dir.join("来源 图片.jpg");
        fs::write(
            &source,
            crate::migration::fixtures::jpeg_with(
                Some(&crate::migration::fixtures::tiff_exif(6, 32, 24)),
                Some(&crate::migration::fixtures::fake_icc()),
                Some(&crate::migration::fixtures::known_xmp()),
            ),
        )
        .unwrap();
        let item = export_file_with_progress(
            ExportRequest {
                source,
                source_name: "来源 图片.jpg".into(),
                source_kind: Kind::Jpeg,
                output_dir: dir.join("纯钧导出"),
                edit: Edit {
                    keep_smaller: false,
                    output_format: "png".into(),
                    suffix: "_纯钧".into(),
                    ..Edit::default()
                },
                mark: None,
                protected_sources: Vec::new(),
            },
            &|_, _| {},
        );
        assert_eq!(item.state, "success", "{}", item.message);
        assert!(item.message.contains("已迁移并复检"), "{}", item.message);
        // 从磁盘重读副本逐字段核对：迁移必须落在文件上，不只是内存里说过。
        let bytes = fs::read(dir.join("纯钧导出").join(&item.output_name)).unwrap();
        let out = crate::migration::extract(&bytes, Kind::Png);
        assert_eq!(out.icc_raw, Some(crate::migration::fixtures::fake_icc()));
        assert_eq!(out.xmp, vec![crate::migration::fixtures::known_xmp()]);
        let tiff = out.exif_tiff.expect("EXIF 应写入副本");
        assert_eq!(crate::migration::exif_field_count(&tiff), 6);
        assert_eq!(crate::migration::orientation_of_tiff(&tiff), 1);
    }
}
