use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::model::{FileRecord, Kind, MAX_FILE_BYTES, MAX_IMPORT};

#[derive(Debug, Clone)]
pub struct InputGrant {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub kind: Kind,
    pub record: FileRecord,
}

#[derive(Debug, Clone)]
pub struct OutputGrant {
    pub id: String,
    pub path: PathBuf,
    pub label: String,
}

#[derive(Debug, Default)]
pub struct GrantStore {
    next: u64,
    pub inputs: std::collections::HashMap<String, InputGrant>,
    pub output: Option<OutputGrant>,
    seen: HashSet<PathBuf>,
}

impl GrantStore {
    pub fn insert(&mut self, path: PathBuf, kind: Kind, mut record: FileRecord) -> FileRecord {
        self.next += 1;
        let id = format!("g{}", self.next);
        record.id = id.clone();
        let name = record.name.clone();
        self.seen.insert(path.clone());
        self.inputs.insert(
            id,
            InputGrant {
                id: record.id.clone(),
                path,
                name,
                kind,
                record: record.clone(),
            },
        );
        record
    }

    pub fn get(&self, id: &str) -> Result<&InputGrant, String> {
        self.inputs
            .get(id)
            .ok_or_else(|| "文件授权无效或已移除".into())
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        let grant = self.inputs.remove(id).ok_or("文件授权无效或已移除")?;
        self.seen.remove(&grant.path);
        Ok(())
    }

    pub fn contains_path(&self, path: &Path) -> bool {
        self.seen.contains(path)
    }

    pub fn set_output(&mut self, path: PathBuf) -> OutputGrant {
        self.next += 1;
        let label = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "导出目录".into());
        let grant = OutputGrant {
            id: format!("o{}", self.next),
            path,
            label,
        };
        self.output = Some(grant.clone());
        grant
    }

    pub fn clear_output(&mut self) {
        self.output = None;
    }
}

pub fn check_file(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "无法读取文件权限或路径".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("已跳过符号链接".into());
    }
    if !metadata.is_file() {
        return Err("不是文件".into());
    }
    if metadata.len() == 0 {
        return Err("文件是空的".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("文件超过 80MB 上限".into());
    }
    fs::canonicalize(path).map_err(|_| "无法规范化路径".into())
}

/// 收集目录下的图片文件。`exclude` 是当前导出目录：它的内容是本应用刚写出的
/// 副本，重新导入会形成自我循环，逐项跳过（规范化后比较，避免路径写法差异）。
pub fn collect_files(
    root: &Path,
    recursive: bool,
    exclude: Option<&Path>,
) -> Vec<Result<PathBuf, String>> {
    let mut found = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0u8)];
    while let Some((dir, depth)) = pending.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                found.push(Err(format!(
                    "无法读取文件夹：{}",
                    dir.file_name().unwrap_or_default().to_string_lossy()
                )));
                continue;
            }
        };
        for entry in entries {
            if found.len() >= MAX_IMPORT {
                found.push(Err("已达到单次导入上限".into()));
                return found;
            }
            let Ok(entry) = entry else {
                found.push(Err("有一项无法读取，已跳过".into()));
                continue;
            };
            let path = entry.path();
            if exclude.is_some_and(|excluded| is_under(&path, excluded)) {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                found.push(Err("有一项无法读取权限，已跳过".into()));
                continue;
            };
            if metadata.file_type().is_symlink() {
                found.push(Err("已跳过符号链接".into()));
                continue;
            }
            if metadata.is_dir() {
                if recursive && depth < 8 {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            found.push(check_file(&path));
        }
    }
    found
}

/// 路径是否落在排除目录内（含相等）；规范化失败按不在处理，交给后续校验。
fn is_under(path: &Path, excluded: &Path) -> bool {
    if path == excluded || path.starts_with(excluded) {
        return true;
    }
    match (fs::canonicalize(path), fs::canonicalize(excluded)) {
        (Ok(path), Ok(excluded)) => path == excluded || path.starts_with(excluded),
        _ => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    Number,
    Skip,
    Replace,
}

impl Conflict {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "number" => Ok(Self::Number),
            "skip" => Ok(Self::Skip),
            "replace" => Ok(Self::Replace),
            _ => Err("重名策略无效".into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedWrite {
    pub path: PathBuf,
    pub skip: bool,
}

pub fn safe_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|ch| {
            ch.is_alphanumeric()
                || matches!(
                    ch,
                    '-' | '_' | ' ' | '·' | '（' | '）' | '(' | ')' | '[' | ']'
                )
        })
        .take(48)
        .collect();
    cleaned.trim().to_string()
}

pub fn plan_destination(
    directory: &Path,
    stem: &str,
    extension: &str,
    prefix: &str,
    suffix: &str,
    source: &Path,
    conflict: Conflict,
) -> Result<PlannedWrite, String> {
    let directory =
        fs::canonicalize(directory).map_err(|_| "导出目录不存在或无法访问".to_string())?;
    let source = fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    let stem = {
        let prefix = safe_name(prefix);
        let suffix = safe_name(suffix);
        let body = safe_name(stem);
        let body = if body.is_empty() {
            "图片".into()
        } else {
            body
        };
        format!("{prefix}{body}{suffix}")
    };
    let extension = safe_name(extension);
    if extension.is_empty() {
        return Err("输出扩展名无效".into());
    }
    for index in 1..=999 {
        let file_name = if index == 1 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        let candidate = directory.join(&file_name);
        let exists = candidate.exists();
        let same_source =
            fs::canonicalize(&candidate).ok().as_ref() == Some(&source) || candidate == source;
        if same_source {
            match conflict {
                Conflict::Replace => return Err("不能覆盖源文件".into()),
                Conflict::Skip => {
                    return Ok(PlannedWrite {
                        path: candidate,
                        skip: true,
                    });
                }
                Conflict::Number => continue,
            }
        }
        if !exists {
            return Ok(PlannedWrite {
                path: candidate,
                skip: false,
            });
        }
        match conflict {
            Conflict::Number => continue,
            Conflict::Skip => {
                return Ok(PlannedWrite {
                    path: candidate,
                    skip: true,
                });
            }
            Conflict::Replace => {
                return Ok(PlannedWrite {
                    path: candidate,
                    skip: false,
                });
            }
        }
    }
    Err("重名编号已用尽".into())
}

pub fn default_output_dir(source: &Path) -> PathBuf {
    source.parent().unwrap_or(Path::new(".")).join("纯钧导出")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "chunjun-grant-{}-{}",
            std::process::id(),
            unique_stamp()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn unique_stamp() -> u128 {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let count = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        nanos + u128::from(count)
    }

    #[test]
    fn unknown_grant_is_rejected() {
        let store = GrantStore::default();
        let error = store.get("missing").unwrap_err();
        assert!(error.contains("授权"));
    }

    #[test]
    fn numbering_never_selects_the_source_file() {
        let dir = temp_dir();
        let source = dir.join("照片.jpg");
        fs::write(&source, b"source").unwrap();
        let numbered =
            plan_destination(&dir, "照片", "jpg", "", "", &source, Conflict::Number).unwrap();
        assert!(!numbered.skip);
        assert_ne!(numbered.path, source);
        assert!(numbered
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("-2"));
        let replaced = plan_destination(&dir, "照片", "jpg", "", "", &source, Conflict::Replace);
        assert!(replaced.unwrap_err().contains("源文件"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_copy_gets_the_next_number() {
        let dir = temp_dir();
        let source = dir.join("源.jpg");
        fs::write(&source, b"source").unwrap();
        fs::write(dir.join("结果.jpg"), b"old").unwrap();
        let plan =
            plan_destination(&dir, "结果", "jpg", "", "", &source, Conflict::Number).unwrap();
        assert_eq!(plan.path.file_name().unwrap(), "结果-2.jpg");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn symlink_is_rejected_when_the_platform_allows_creating_one() {
        let dir = temp_dir();
        let source = dir.join("原图.jpg");
        fs::write(&source, b"source").unwrap();
        let link = dir.join("链接.jpg");
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(&source, &link);
        #[cfg(not(windows))]
        let created = std::os::unix::fs::symlink(&source, &link);
        if created.is_ok() {
            let error = check_file(&link).unwrap_err();
            assert!(error.contains("符号链接"));
        } else {
            let metadata = fs::symlink_metadata(&source).unwrap();
            assert!(!metadata.file_type().is_symlink());
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_files_skips_the_output_directory() {
        let dir = temp_dir();
        fs::write(dir.join("a.png"), b"png").unwrap();
        let output = dir.join("纯钧导出");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("a-纯钧.png"), b"copy").unwrap();
        let excluded = collect_files(&dir, true, Some(&output));
        let names: Vec<String> = excluded
            .iter()
            .filter_map(|item| {
                item.as_ref()
                    .ok()
                    .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            })
            .collect();
        assert_eq!(names, vec!["a.png".to_string()], "导出目录里的副本不导入");
        let plain = collect_files(&dir, true, None);
        assert_eq!(plain.len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
