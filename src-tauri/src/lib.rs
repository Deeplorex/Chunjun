mod export;
mod grant;
mod image_ops;
mod metadata;
mod migration;
mod model;
mod window_fit;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use grant::{default_output_dir, GrantStore};
use model::{
    DraftView, Edit, Evidence, ExportFile, ExportItem, ExportReport, FileRecord, HistoryItem, Kind,
    OutputInfo, PreviewExport, PreviewImage, Settings,
};

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "svg", "avif", "heic", "heif",
];

struct Session {
    grants: GrantStore,
    settings: Settings,
    history: Vec<StoredHistory>,
    draft_document: String,
    dropped_paths: HashSet<PathBuf>,
    /// 拖放目录展开时无法读取的项；import_paths 取走后转成失败记录上报。
    dropped_errors: Vec<String>,
}

struct StoredHistory {
    id: String,
    label: String,
    path: PathBuf,
    success: usize,
    failed: usize,
    below_target: usize,
}

struct Task {
    id: String,
    source: PathBuf,
    name: String,
    kind: Kind,
    edit: Edit,
    mark: Option<Vec<u8>>,
    failure: Option<String>,
}

struct JobShared {
    pause: AtomicBool,
    cancel: AtomicBool,
    tasks: Vec<Task>,
    output: Option<PathBuf>,
    write_report: bool,
    protected_sources: Vec<PathBuf>,
}

struct AppState {
    data_dir: Mutex<PathBuf>,
    session: Mutex<Session>,
    jobs: Mutex<HashMap<String, Arc<JobShared>>>,
    next_job: Mutex<u64>,
    last_report: Mutex<Option<ExportReport>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            data_dir: Mutex::new(std::env::temp_dir().join("chunjun")),
            session: Mutex::new(Session {
                grants: GrantStore::default(),
                settings: Settings::default(),
                history: Vec::new(),
                draft_document: String::new(),
                dropped_paths: HashSet::new(),
                dropped_errors: Vec::new(),
            }),
            jobs: Mutex::new(HashMap::new()),
            next_job: Mutex::new(1),
            last_report: Mutex::new(None),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobEvent {
    kind: String,
    job_id: String,
    done: usize,
    total: usize,
    name: String,
    phase: String,
    /// 整体完成度 0..1，用来推进度条。多个并发任务按各自阶段加权求和。
    fraction: f64,
    item: Option<ExportItem>,
    report: Option<ExportReport>,
}

fn lock_error() -> String {
    "内部状态暂时不可用".into()
}

fn import_path(session: &mut Session, path: PathBuf) -> FileRecord {
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "图片".into());
    if session.grants.inputs.len() >= model::MAX_IMPORT {
        return failed_record(display_name, "会话导入数量已达上限（200 张）".into());
    }
    let canonical = match grant::check_file(&path) {
        Ok(path) => path,
        Err(message) => return failed_record(display_name, message),
    };
    if session.grants.contains_path(&canonical) {
        return failed_record(display_name, "重复项已跳过".into());
    }
    let bytes = match fs::read(&canonical) {
        Ok(bytes) => bytes,
        Err(_) => return failed_record(display_name, "没有读取权限".into()),
    };
    let inspected = image_ops::inspect(&bytes);
    let record = FileRecord {
        id: String::new(),
        name: display_name,
        format: inspected.kind.label().into(),
        width: inspected.width,
        height: inspected.height,
        bytes: bytes.len() as u64,
        status: inspected.status,
        message: inspected.message,
        animated: inspected.animated,
        pages: inspected.pages,
        has_alpha: inspected.has_alpha,
    };
    if record.status == "ready" || record.status == "unsupported" || record.status == "failed" {
        session.grants.insert(canonical, inspected.kind, record)
    } else {
        record
    }
}

fn failed_record(name: String, message: String) -> FileRecord {
    FileRecord {
        id: String::new(),
        name,
        format: "未知".into(),
        width: 0,
        height: 0,
        bytes: 0,
        status: "failed".into(),
        message,
        animated: false,
        pages: 0,
        has_alpha: false,
    }
}

fn import_many(session: &mut Session, paths: Vec<PathBuf>) -> Vec<FileRecord> {
    paths
        .into_iter()
        .map(|path| import_path(session, path))
        .collect()
}

#[tauri::command]
fn app_status() -> &'static str {
    "ready"
}

#[tauri::command]
fn pick_images(app: AppHandle, state: State<AppState>) -> Result<Vec<FileRecord>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("图片", IMAGE_EXTENSIONS)
        .blocking_pick_files();
    let Some(files) = picked else {
        return Ok(Vec::new());
    };
    let mut paths = Vec::new();
    for file in files {
        paths.push(file.into_path().map_err(|error| error.to_string())?);
    }
    let mut session = state.session.lock().map_err(|_| lock_error())?;
    Ok(import_many(&mut session, paths))
}

#[tauri::command]
fn pick_folder(
    app: AppHandle,
    state: State<AppState>,
    recursive: bool,
) -> Result<Vec<FileRecord>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(folder) = picked else {
        return Ok(Vec::new());
    };
    let path = folder.into_path().map_err(|error| error.to_string())?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| "无法读取文件夹".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("已拒绝符号链接文件夹".into());
    }
    // 排除当前导出目录，避免把刚写出的副本又导入回来。
    let exclude = {
        let session = state.session.lock().map_err(|_| lock_error())?;
        session
            .grants
            .output
            .as_ref()
            .map(|grant| grant.path.clone())
    };
    let found = grant::collect_files(&path, recursive, exclude.as_deref());
    let mut session = state.session.lock().map_err(|_| lock_error())?;
    let mut records = Vec::new();
    for item in found {
        match item {
            Ok(path) => records.push(import_path(&mut session, path)),
            Err(message) => records.push(failed_record("导入项".into(), message)),
        }
    }
    Ok(records)
}

#[tauri::command]
fn import_paths(state: State<AppState>, paths: Vec<String>) -> Result<Vec<FileRecord>, String> {
    let mut session = state.session.lock().map_err(|_| lock_error())?;
    let paths = take_dropped_paths(&mut session, paths)?;
    let mut records: Vec<FileRecord> = session
        .dropped_errors
        .drain(..)
        .map(|message| failed_record("拖放目录中的项".into(), message))
        .collect();
    records.extend(import_many(&mut session, paths));
    Ok(records)
}

fn take_dropped_paths(session: &mut Session, paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    if paths.is_empty()
        || paths.len() > model::MAX_IMPORT
        || paths
            .iter()
            .any(|path| !session.dropped_paths.contains(path))
    {
        return Err("文件未经原生拖放授权，请重新拖入或使用选择图片。".into());
    }
    for path in &paths {
        session.dropped_paths.remove(path);
    }
    Ok(paths)
}

/// 剪贴板图片的接收预算：像素与字节数都有上限，超限给出明确错误而不是
/// 试图把整块数据搬进内存。
fn clipboard_budget(width: u32, height: u32, bytes: usize) -> Result<(), String> {
    if u64::from(width) * u64::from(height) > model::MAX_PIXELS {
        return Err("剪贴板图片超过 4000 万像素上限，请先在图片工具里缩小再复制".into());
    }
    if bytes > 160 * 1024 * 1024 {
        return Err("剪贴板图片数据超过 160MB 上限，请先在图片工具里缩小再复制".into());
    }
    Ok(())
}

#[tauri::command]
fn import_clipboard(state: State<AppState>) -> Result<Vec<FileRecord>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|_| "无法打开剪贴板".to_string())?;
    let image = clipboard
        .get_image()
        .map_err(|_| "剪贴板里没有图片".to_string())?;
    let width = u32::try_from(image.width).map_err(|_| "剪贴板图片尺寸无效")?;
    let height = u32::try_from(image.height).map_err(|_| "剪贴板图片尺寸无效")?;
    clipboard_budget(width, height, image.bytes.len())?;
    let buffer = image::RgbaImage::from_raw(width, height, image.bytes.into_owned())
        .ok_or("剪贴板图片无法读取")?;
    let dir = state
        .data_dir
        .lock()
        .map_err(|_| lock_error())?
        .join("clipboard");
    fs::create_dir_all(&dir).map_err(|_| "无法保存剪贴板副本".to_string())?;
    let path = dir.join(format!("clipboard-{}.png", unique_suffix()));
    image::DynamicImage::ImageRgba8(buffer)
        .save(&path)
        .map_err(|_| "无法保存剪贴板副本".to_string())?;
    // 磁盘缓存只留最近 20 份，导入顺手清理，避免无限增长。
    prune_clipboard_cache(&dir, 20);
    let mut session = state.session.lock().map_err(|_| lock_error())?;
    Ok(vec![import_path(&mut session, path)])
}

#[tauri::command]
fn remove_files(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|_| lock_error())?;
    for id in ids {
        session.grants.remove(&id)?;
    }
    Ok(())
}

#[tauri::command]
fn pick_output(app: AppHandle, state: State<AppState>) -> Result<Option<OutputInfo>, String> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|error| error.to_string())?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| "无法读取导出目录".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("已拒绝符号链接导出目录".into());
    }
    let canonical = fs::canonicalize(&path).map_err(|_| "无法规范化导出目录".to_string())?;
    let mut session = state.session.lock().map_err(|_| lock_error())?;
    let grant = session.grants.set_output(canonical);
    // 记住这个选择：下次启动直接恢复为本会话输出目录（恢复的是应用内的记录，
    // 不是系统对话框的重新授权；目录消失或变成链接时忽略）。
    if let Ok(dir) = state.data_dir.lock() {
        let stored = serde_json::json!({
            "version": 1,
            "path": grant.path,
        });
        let _ = atomic_write(
            &dir,
            "output-v1.json",
            serde_json::to_vec_pretty(&stored)
                .unwrap_or_default()
                .as_slice(),
        );
    }
    Ok(Some(OutputInfo {
        id: grant.id,
        label: grant.label,
    }))
}

#[tauri::command]
fn current_output(state: State<AppState>) -> Result<Option<OutputInfo>, String> {
    let session = state.session.lock().map_err(|_| lock_error())?;
    Ok(session.grants.output.as_ref().map(|grant| OutputInfo {
        id: grant.id.clone(),
        label: grant.label.clone(),
    }))
}

#[tauri::command]
fn clear_output(state: State<AppState>) -> Result<(), String> {
    state
        .session
        .lock()
        .map_err(|_| lock_error())?
        .grants
        .clear_output();
    Ok(())
}

#[tauri::command]
async fn file_preview(state: State<'_, AppState>, id: String) -> Result<PreviewImage, String> {
    let (path, kind) = {
        let session = state.session.lock().map_err(|_| lock_error())?;
        let grant = session.grants.get(&id)?;
        (grant.path.clone(), grant.kind)
    };
    let bytes = fs::read(&path).map_err(|_| "源文件已移动或无法读取".to_string())?;
    let (png_base64, width, height) =
        tauri::async_runtime::spawn_blocking(move || image_ops::preview_png_base64(&bytes, kind))
            .await
            .map_err(|_| "预览任务中断".to_string())??;
    Ok(PreviewImage {
        png_base64,
        width,
        height,
    })
}

#[tauri::command]
fn file_evidence(state: State<AppState>, id: String) -> Result<Evidence, String> {
    let path = {
        let session = state.session.lock().map_err(|_| lock_error())?;
        session.grants.get(&id)?.path.clone()
    };
    let bytes = fs::read(&path).map_err(|_| "源文件已移动或无法读取".to_string())?;
    Ok(metadata::read_evidence(&bytes))
}

#[tauri::command]
async fn preview_export(
    state: State<'_, AppState>,
    id: String,
    edit: Edit,
) -> Result<PreviewExport, String> {
    let (path, kind, mark) = {
        let session = state.session.lock().map_err(|_| lock_error())?;
        let grant = session.grants.get(&id)?;
        let mark = read_mark(&session, &edit)?;
        (grant.path.clone(), grant.kind, mark)
    };
    let bytes = fs::read(&path).map_err(|_| "源文件已移动或无法读取".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        image_ops::preview_export(&bytes, &edit, kind, mark.as_deref())
    })
    .await
    .map_err(|_| "预览任务中断".to_string())?
}

fn read_mark(session: &Session, edit: &Edit) -> Result<Option<Vec<u8>>, String> {
    let id = edit.watermark_image_id.trim();
    if !edit.watermark || id.is_empty() {
        return Ok(None);
    }
    let grant = session.grants.get(id)?;
    if grant.record.status != "ready" {
        return Err(format!("{} 还不能当作水印", grant.name));
    }
    fs::read(&grant.path)
        .map(Some)
        .map_err(|_| "水印图片已移动或无法读取".to_string())
}

#[tauri::command]
fn start_export(
    app: AppHandle,
    state: State<AppState>,
    files: Vec<ExportFile>,
    write_report: bool,
) -> Result<String, String> {
    if files.is_empty() {
        return Err("没有可导出的文件".into());
    }
    let (tasks, output, concurrency, protected_sources) = {
        let session = state.session.lock().map_err(|_| lock_error())?;
        let mut tasks = Vec::new();
        for file in files {
            let grant = session.grants.get(&file.id)?;
            let mut failure = file.edit.validate().err();
            if failure.is_none() && grant.record.status != "ready" {
                failure = Some(format!(
                    "{} 还不能导出：{}",
                    grant.name, grant.record.message
                ));
            }
            let mut mark = None;
            if failure.is_none() {
                match read_mark(&session, &file.edit) {
                    Ok(value) => mark = value,
                    Err(message) => failure = Some(message),
                }
            }
            tasks.push(Task {
                id: grant.id.clone(),
                source: grant.path.clone(),
                name: grant.name.clone(),
                kind: grant.kind,
                edit: file.edit,
                mark,
                failure,
            });
        }
        (
            tasks,
            session
                .grants
                .output
                .as_ref()
                .map(|grant| grant.path.clone()),
            session.settings.concurrency.clamp(1, 2),
            session
                .grants
                .inputs
                .values()
                .map(|grant| grant.path.clone())
                .collect(),
        )
    };
    let job_id = {
        let mut next = state.next_job.lock().map_err(|_| lock_error())?;
        let id = format!("job{next}");
        *next += 1;
        id
    };
    let shared = Arc::new(JobShared {
        pause: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        tasks,
        output,
        write_report,
        protected_sources,
    });
    state
        .jobs
        .lock()
        .map_err(|_| lock_error())?
        .insert(job_id.clone(), Arc::clone(&shared));
    let job_for_thread = job_id.clone();
    let app_for_thread = app.clone();
    std::thread::spawn(move || run_job(app_for_thread, job_for_thread, shared, concurrency));
    Ok(job_id)
}

fn overall_fraction(
    stages: &Mutex<HashMap<usize, f32>>,
    finished: &AtomicUsize,
    total: usize,
) -> f64 {
    let active = stages
        .lock()
        .map(|table| table.values().sum::<f32>())
        .unwrap_or(0.0);
    let done = finished.load(Ordering::Relaxed) as f32;
    f64::from(((done + active) / (total.max(1) as f32)).min(1.0))
}

/// 工作线程每轮取任务前的判定：取消优先于暂停，暂停中收到取消必须停止，
/// 不能再领下一项。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerGate {
    Run,
    Wait,
    Stop,
}

fn worker_gate(paused: bool, cancelled: bool) -> WorkerGate {
    if cancelled {
        WorkerGate::Stop
    } else if paused {
        WorkerGate::Wait
    } else {
        WorkerGate::Run
    }
}

/// 并发下整体进度只升不降：阶段表与完成计数非原子，瞬时和可能回跳，用历史
/// 最大值钳制后上报。
fn monotonic_fraction(ceiling: &Mutex<f64>, value: f64) -> f64 {
    ceiling
        .lock()
        .map(|mut top| {
            if value > *top {
                *top = value;
            }
            *top
        })
        .unwrap_or(value)
}

/// 任务运行需要的环境：发事件、记历史与最新报告、清理任务注册表。
/// 桌面用 AppHandle 实现；测试用记录器实现，直接跑真实任务编排。
trait JobContext: Sync {
    fn emit(&self, event: &JobEvent);
    fn remember(&self, report: &ExportReport, directory: PathBuf);
    fn forget(&self, job_id: &str);
}

struct AppJobContext(AppHandle);

impl JobContext for AppJobContext {
    fn emit(&self, event: &JobEvent) {
        let _ = self.0.emit("chunjun-job", event);
    }

    fn remember(&self, report: &ExportReport, directory: PathBuf) {
        remember_history(&self.0, report, directory);
        if let Some(state) = self.0.try_state::<AppState>() {
            if let Ok(mut slot) = state.last_report.lock() {
                *slot = Some(report.clone());
            }
        }
    }

    fn forget(&self, job_id: &str) {
        if let Some(state) = self.0.try_state::<AppState>() {
            if let Ok(mut jobs) = state.jobs.lock() {
                jobs.remove(job_id);
            }
        }
    }
}

fn run_job(app: AppHandle, job_id: String, job: Arc<JobShared>, concurrency: u8) {
    run_job_with(&AppJobContext(app), job_id, job, concurrency);
}

fn run_job_with(ctx: &dyn JobContext, job_id: String, job: Arc<JobShared>, concurrency: u8) {
    let total = job.tasks.len();
    let results = Mutex::new(vec![None; total]);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let finished = std::sync::atomic::AtomicUsize::new(0);
    let workers = usize::from(concurrency.max(1));
    // 每张图当前所处阶段（0..1），并发时按已完成数加权求出整体进度。
    let stages: Mutex<HashMap<usize, f32>> = Mutex::new(HashMap::new());
    // 整体进度历史最大值：上报前钳制，保证事件流单调不回退。
    let ceiling: Mutex<f64> = Mutex::new(0.0);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let results = &results;
            let next = &next;
            let finished = &finished;
            let job = &job;
            let job_id = &job_id;
            let stages = &stages;
            let ceiling = &ceiling;
            // 阶段事件按 120ms 节流，避免大图编码时把 IPC 打满。
            let last_stage = RefCell::new(Instant::now() - Duration::from_secs(5));
            scope.spawn(move || loop {
                match worker_gate(
                    job.pause.load(Ordering::Relaxed),
                    job.cancel.load(Ordering::Relaxed),
                ) {
                    WorkerGate::Stop => break,
                    WorkerGate::Wait => {
                        ctx.emit(&JobEvent {
                            kind: "paused".into(),
                            job_id: job_id.clone(),
                            done: finished.load(Ordering::Relaxed),
                            total,
                            name: String::new(),
                            phase: "已暂停，下一项还没开始".into(),
                            fraction: monotonic_fraction(
                                ceiling,
                                overall_fraction(stages, finished, total),
                            ),
                            item: None,
                            report: None,
                        });
                        std::thread::sleep(Duration::from_millis(200));
                        continue;
                    }
                    WorkerGate::Run => {}
                }
                let index = next.fetch_add(1, Ordering::Relaxed);
                if index >= total {
                    break;
                }
                let task = &job.tasks[index];
                ctx.emit(&JobEvent {
                    kind: "progress".into(),
                    job_id: job_id.clone(),
                    done: finished.load(Ordering::Relaxed),
                    total,
                    name: task.name.clone(),
                    phase: "准备处理".into(),
                    fraction: monotonic_fraction(
                        ceiling,
                        overall_fraction(stages, finished, total),
                    ),
                    item: None,
                    report: None,
                });
                let mut item = if let Some(message) = &task.failure {
                    ExportItem {
                        id: task.id.clone(),
                        name: task.name.clone(),
                        state: "failed".into(),
                        message: message.clone(),
                        output_name: String::new(),
                        output_path: String::new(),
                        bytes: 0,
                        source_bytes: 0,
                        saved_bytes: 0,
                    }
                } else {
                    let output_dir = job
                        .output
                        .clone()
                        .unwrap_or_else(|| default_output_dir(&task.source));
                    export::export_file_with_progress(
                        export::ExportRequest {
                            source: task.source.clone(),
                            source_name: task.name.clone(),
                            source_kind: task.kind,
                            output_dir,
                            edit: task.edit.clone(),
                            mark: task.mark.clone(),
                            protected_sources: job.protected_sources.clone(),
                        },
                        &|phase, fraction| {
                            let Ok(mut table) = stages.lock() else {
                                return;
                            };
                            table.insert(index, fraction.clamp(0.0, 0.99));
                            let active: f32 = table.values().sum();
                            let overall = (finished.load(Ordering::Relaxed) as f32 + active)
                                / (total.max(1) as f32);
                            drop(table);
                            let mut last = last_stage.borrow_mut();
                            if last.elapsed() < Duration::from_millis(120) {
                                return;
                            }
                            *last = Instant::now();
                            drop(last);
                            ctx.emit(&JobEvent {
                                kind: "progress".into(),
                                job_id: job_id.clone(),
                                done: finished.load(Ordering::Relaxed),
                                total,
                                name: task.name.clone(),
                                phase: phase.to_string(),
                                fraction: monotonic_fraction(ceiling, f64::from(overall.min(1.0))),
                                item: None,
                                report: None,
                            });
                        },
                    )
                };
                item.id = task.id.clone();
                if let Ok(mut table) = stages.lock() {
                    table.remove(&index);
                }
                if let Ok(mut slot) = results.lock() {
                    slot[index] = Some(item.clone());
                }
                let done = finished.fetch_add(1, Ordering::Relaxed) + 1;
                ctx.emit(&JobEvent {
                    kind: "item".into(),
                    job_id: job_id.clone(),
                    done: done.min(total),
                    total,
                    name: item.name.clone(),
                    phase: item.message.clone(),
                    fraction: monotonic_fraction(
                        ceiling,
                        ((done.min(total)) as f64) / (total.max(1) as f64),
                    ),
                    item: Some(item),
                    report: None,
                });
            });
        }
    });
    let items: Vec<ExportItem> = results
        .into_inner()
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .collect();
    // 取消时没被领走的任务数：正常结束恰好为 0。
    let cancelled = total.saturating_sub(items.len());
    let mut report_note = String::new();
    if job.write_report {
        if let Some(directory) = job.output.clone().or_else(|| {
            items.first().and_then(|_| {
                job.tasks
                    .first()
                    .map(|task| default_output_dir(&task.source))
            })
        }) {
            // 报告写失败必须可见，不能吞掉后假装写成功。
            if let Err(message) = export::write_report(&directory, &items) {
                report_note = format!("来源报告写入失败：{message}。");
            }
        }
    }
    let report = summarize(&job_id, &items, job.output.as_deref(), cancelled);
    // 历史与最新报告：自选目录与原目录的纯钧导出子目录都记，结果页“打开文件夹”
    // 对两种位置都能用；全部取消（没有任何结果）时不记。
    let history_dir = job.output.clone().or_else(|| {
        job.tasks
            .first()
            .map(|task| default_output_dir(&task.source))
    });
    if let Some(directory) = history_dir.filter(|_| !items.is_empty()) {
        ctx.remember(&report, directory);
    }
    let mut phase = if job.cancel.load(Ordering::Relaxed) {
        format!("已取消，保留已完成的副本；{cancelled} 项未执行。")
    } else {
        "处理结束".to_string()
    };
    if !report_note.is_empty() {
        phase = format!("{phase}{report_note}");
    }
    ctx.emit(&JobEvent {
        kind: "done".into(),
        job_id: job_id.clone(),
        done: items.len(),
        total,
        name: String::new(),
        phase,
        fraction: if job.cancel.load(Ordering::Relaxed) {
            monotonic_fraction(&ceiling, (items.len() as f64) / (total.max(1) as f64))
        } else {
            1.0
        },
        item: None,
        report: Some(report),
    });
    // 任务已结束：从注册表移除，释放任务数据；迟到的暂停/取消指令按找不到任务报错。
    ctx.forget(&job_id);
}

fn summarize(
    job_id: &str,
    items: &[ExportItem],
    output: Option<&Path>,
    cancelled: usize,
) -> ExportReport {
    let mut report = ExportReport {
        job_id: job_id.into(),
        success: 0,
        skipped: 0,
        failed: 0,
        below_target: 0,
        cancelled,
        saved_bytes: 0,
        items: items.to_vec(),
        output_label: output
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "纯钧导出".into()),
    };
    for item in items {
        report.saved_bytes += item.saved_bytes;
        match item.state.as_str() {
            "success" => report.success += 1,
            "skipped" => report.skipped += 1,
            "below_target" => report.below_target += 1,
            _ => report.failed += 1,
        }
    }
    report
}

fn remember_history(app: &AppHandle, report: &ExportReport, directory: PathBuf) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(mut session) = state.session.lock() else {
        return;
    };
    if !session.settings.history_enabled {
        return;
    }
    session.history.insert(
        0,
        StoredHistory {
            id: report.job_id.clone(),
            label: report.output_label.clone(),
            path: directory,
            success: report.success,
            failed: report.failed,
            below_target: report.below_target,
        },
    );
    session.history.truncate(30);
    persist_history(&state, &session.history);
}

fn job_flag(state: &State<AppState>, job_id: &str) -> Result<Arc<JobShared>, String> {
    state
        .jobs
        .lock()
        .map_err(|_| lock_error())?
        .get(job_id)
        .cloned()
        .ok_or_else(|| "找不到这个任务".to_string())
}

#[tauri::command]
fn pause_job(state: State<AppState>, job_id: String) -> Result<(), String> {
    job_flag(&state, &job_id)?
        .pause
        .store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn resume_job(state: State<AppState>, job_id: String) -> Result<(), String> {
    job_flag(&state, &job_id)?
        .pause
        .store(false, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn cancel_job(state: State<AppState>, job_id: String) -> Result<(), String> {
    let job = job_flag(&state, &job_id)?;
    job.cancel.store(true, Ordering::Relaxed);
    job.pause.store(false, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn open_output(state: State<AppState>, job_id: Option<String>) -> Result<(), String> {
    let path = {
        let session = state.session.lock().map_err(|_| lock_error())?;
        if let Some(job_id) = job_id {
            session
                .history
                .iter()
                .find(|item| item.id == job_id)
                .map(|item| item.path.clone())
                .or_else(|| {
                    session
                        .grants
                        .output
                        .as_ref()
                        .map(|grant| grant.path.clone())
                })
                .ok_or("没有可打开的导出目录")?
        } else {
            session
                .grants
                .output
                .as_ref()
                .map(|grant| grant.path.clone())
                .ok_or("还没有选择导出目录")?
        }
    };
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|_| "无法打开导出目录".to_string())?;
    Ok(())
}

fn find_export_item(
    state: &State<AppState>,
    job_id: &str,
    file_id: &str,
) -> Result<ExportItem, String> {
    let report = state.last_report.lock().map_err(|_| lock_error())?;
    let report = report.as_ref().ok_or("还没有导出结果")?;
    if report.job_id != job_id {
        return Err("导出记录已失效，请重新导出".into());
    }
    report
        .items
        .iter()
        .find(|item| item.id == file_id)
        .cloned()
        .ok_or_else(|| "找不到这张图片的导出结果".to_string())
}

fn kind_from_name(name: &str) -> Kind {
    match Path::new(name)
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "jpg" | "jpeg" => Kind::Jpeg,
        "png" => Kind::Png,
        "gif" => Kind::Gif,
        "webp" => Kind::Webp,
        "bmp" => Kind::Bmp,
        "tif" | "tiff" => Kind::Tiff,
        "svg" => Kind::Svg,
        "avif" => Kind::Avif,
        "heic" | "heif" => Kind::Heic,
        _ => Kind::Unknown,
    }
}

#[tauri::command]
async fn export_preview(
    state: State<'_, AppState>,
    job_id: String,
    file_id: String,
) -> Result<PreviewImage, String> {
    let item = find_export_item(&state, &job_id, &file_id)?;
    if item.output_path.is_empty() {
        return Err("这张图片没有导出副本".into());
    }
    let kind = kind_from_name(&item.output_path);
    let bytes = fs::read(&item.output_path).map_err(|_| "导出文件已移动或无法读取".to_string())?;
    let (png_base64, width, height) =
        tauri::async_runtime::spawn_blocking(move || image_ops::preview_png_base64(&bytes, kind))
            .await
            .map_err(|_| "预览任务中断".to_string())??;
    Ok(PreviewImage {
        png_base64,
        width,
        height,
    })
}

#[tauri::command]
async fn export_thumb(
    state: State<'_, AppState>,
    job_id: String,
    file_id: String,
) -> Result<String, String> {
    let item = find_export_item(&state, &job_id, &file_id)?;
    if item.output_path.is_empty() {
        return Err("这张图片没有导出副本".into());
    }
    let kind = kind_from_name(&item.output_path);
    let bytes = fs::read(&item.output_path).map_err(|_| "导出文件已移动或无法读取".to_string())?;
    tauri::async_runtime::spawn_blocking(move || image_ops::thumb_png_base64(&bytes, kind, 96))
        .await
        .map_err(|_| "缩略图任务中断".to_string())?
}

#[tauri::command]
fn export_reveal(state: State<AppState>, job_id: String, file_id: String) -> Result<(), String> {
    let item = find_export_item(&state, &job_id, &file_id)?;
    if item.output_path.is_empty() {
        return Err("这张图片没有导出副本".into());
    }
    std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&item.output_path)
        .spawn()
        .map_err(|_| "无法打开所在文件夹".to_string())?;
    Ok(())
}

#[tauri::command]
fn export_copy(state: State<AppState>, job_id: String, file_id: String) -> Result<(), String> {
    let item = find_export_item(&state, &job_id, &file_id)?;
    if item.output_path.is_empty() {
        return Err("这张图片没有导出副本".into());
    }
    let bytes = fs::read(&item.output_path).map_err(|_| "导出文件已移动或无法读取".to_string())?;
    let image = image::load_from_memory(&bytes)
        .map_err(|_| "这个格式暂时不能复制为图片，请用打开文件夹".to_string())?
        .to_rgba8();
    let (width, height) = image.dimensions();
    let data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: std::borrow::Cow::Owned(image.into_raw()),
    };
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_image(data))
        .map_err(|error| format!("无法写入剪贴板：{error}"))
}

#[tauri::command]
fn load_settings(state: State<AppState>) -> Result<Settings, String> {
    Ok(state
        .session
        .lock()
        .map_err(|_| lock_error())?
        .settings
        .clone())
}

#[tauri::command]
fn save_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    if !(1..=2).contains(&settings.concurrency) {
        return Err("并发只能是 1 或 2".into());
    }
    let mut session = state.session.lock().map_err(|_| lock_error())?;
    session.settings = settings;
    let dir = state.data_dir.lock().map_err(|_| lock_error())?.clone();
    let stored = serde_json::json!({
        "version": 1,
        "settings": session.settings,
    });
    atomic_write(
        &dir,
        "settings-v1.json",
        &serde_json::to_vec_pretty(&stored).map_err(|_| "无法生成设置数据".to_string())?,
    )
    .map_err(|_| "无法保存设置".to_string())?;
    Ok(())
}

#[tauri::command]
fn list_history(state: State<AppState>) -> Result<Vec<HistoryItem>, String> {
    let session = state.session.lock().map_err(|_| lock_error())?;
    Ok(list_history_inner(&session))
}

/// 关闭“保留本机处理记录”时不列出旧条目；已保存的数据不删，重开开关即恢复。
fn list_history_inner(session: &Session) -> Vec<HistoryItem> {
    if !session.settings.history_enabled {
        return Vec::new();
    }
    session
        .history
        .iter()
        .map(|item| HistoryItem {
            id: item.id.clone(),
            label: item.label.clone(),
            success: item.success,
            failed: item.failed,
            below_target: item.below_target,
        })
        .collect()
}

#[tauri::command]
fn clear_history(state: State<AppState>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|_| lock_error())?;
    session.history.clear();
    persist_history(&state, &session.history);
    Ok(())
}

#[tauri::command]
fn save_draft(state: State<AppState>, ids: Vec<String>, document: String) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|_| lock_error())?;
    let mut paths = Vec::new();
    for id in ids {
        paths.push(session.grants.get(&id)?.path.to_string_lossy().to_string());
    }
    session.draft_document = document.clone();
    let dir = state.data_dir.lock().map_err(|_| lock_error())?.clone();
    let stored = serde_json::json!({
        "version": 1,
        "paths": paths,
        "document": document,
    });
    atomic_write(
        &dir,
        "draft-v1.json",
        &serde_json::to_vec_pretty(&stored).map_err(|_| "无法生成草稿数据".to_string())?,
    )
    .map_err(|_| "无法保存草稿".to_string())?;
    Ok(())
}

#[tauri::command]
fn load_draft(state: State<AppState>) -> Result<DraftView, String> {
    let dir = state.data_dir.lock().map_err(|_| lock_error())?.clone();
    let empty = DraftView {
        files: Vec::new(),
        document: String::new(),
    };
    let Some(bytes) = fs::read(dir.join("draft-v1.json")).ok() else {
        return Ok(empty);
    };
    // 损坏的草稿留档后按空草稿处理，不阻塞界面，也不覆盖留档。
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            preserve_corrupt(&dir, "draft-v1.json");
            return Ok(empty);
        }
    };
    let document = value
        .get("document")
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_string();
    let paths = value
        .get("paths")
        .and_then(|item| item.as_array())
        .cloned()
        .unwrap_or_default();
    let mut session = state.session.lock().map_err(|_| lock_error())?;
    let mut files = Vec::new();
    for item in paths {
        let Some(text) = item.as_str() else { continue };
        let path = PathBuf::from(text);
        if path.exists() {
            files.push(import_path(&mut session, path));
        } else {
            files.push(failed_record(
                path.file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| "图片".into()),
                "源文件已移动".into(),
            ));
        }
    }
    session.draft_document = document.clone();
    Ok(DraftView { files, document })
}

fn persist_history(state: &State<AppState>, history: &[StoredHistory]) {
    let Ok(dir) = state.data_dir.lock() else {
        return;
    };
    let stored: Vec<_> = history
        .iter()
        .map(|item| {
            serde_json::json!({
                "id": item.id,
                "label": item.label,
                "path": item.path,
                "success": item.success,
                "failed": item.failed,
                "belowTarget": item.below_target,
            })
        })
        .collect();
    let enveloped = serde_json::json!({
        "version": 1,
        "items": stored,
    });
    let _ = atomic_write(
        &dir,
        "history-v1.json",
        serde_json::to_vec_pretty(&enveloped)
            .unwrap_or_default()
            .as_slice(),
    );
}

fn unique_suffix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 本机 JSON 数据统一走「临时文件 + 原子改名」写入，中途断电/崩溃不会留下
/// 半截文件；失败时旧文件保持原样。
fn atomic_write(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|_| "无法创建数据目录".to_string())?;
    let temp = dir.join(format!("{name}.tmp-{}", std::process::id()));
    fs::write(&temp, bytes).map_err(|_| "无法写入临时文件".to_string())?;
    fs::rename(&temp, dir.join(name)).map_err(|_| "无法原子替换数据文件".to_string())
}

/// 数据文件解析失败时先改名留档再回落默认：损坏的字节不能被下一次保存无痕
/// 覆盖掉，用户仍能从留档里找回内容。
fn preserve_corrupt(dir: &Path, name: &str) {
    let source = dir.join(name);
    let kept = dir.join(format!("{name}.corrupt-{unique}", unique = unique_suffix()));
    let _ = fs::rename(&source, &kept);
}

/// 读带版本包络的 JSON：`{"version":1,"…":…}`；旧版裸格式（设置对象/历史数组）
/// 仍按 v1 兼容读取。损坏时留档并返回 None。
fn read_versioned(dir: &Path, name: &str, key: &str) -> Option<serde_json::Value> {
    let bytes = fs::read(dir.join(name)).ok()?;
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            preserve_corrupt(dir, name);
            return None;
        }
    };
    if value.get("version").is_some() {
        // 包络格式：取内层字段；结构不对按损坏处理并留档。
        match value.get(key).cloned() {
            Some(inner) => Some(inner),
            None => {
                preserve_corrupt(dir, name);
                None
            }
        }
    } else {
        // 旧版裸格式。
        Some(value)
    }
}

/// 剪贴板图片目录只保留最近 `keep` 份副本，其余清掉；这些是本应用的临时缓存，
/// 不是用户文件。
fn prune_clipboard_cache(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let modified = entry.metadata().ok()?.modified().ok()?;
            let name = path.file_name()?.to_string_lossy().to_string();
            (name.starts_with("clipboard-") && name.ends_with(".png")).then_some((path, modified))
        })
        .collect();
    files.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    for (path, _) in files.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
}

fn load_disk_state(state: &AppState) {
    let Ok(dir) = state.data_dir.lock() else {
        return;
    };
    // 设置：损坏文件留档后回落默认（不再被下一次保存无痕覆盖），旧版裸格式兼容。
    if let Some(value) = read_versioned(&dir, "settings-v1.json", "settings") {
        if let Ok(settings) = serde_json::from_value::<Settings>(value) {
            if let Ok(mut session) = state.session.lock() {
                session.settings = settings;
            }
        }
    }
    if let Some(value) = read_versioned(&dir, "history-v1.json", "items") {
        let items = value
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| {
                Some(StoredHistory {
                    id: item.get("id")?.as_str()?.to_string(),
                    label: item.get("label")?.as_str()?.to_string(),
                    path: PathBuf::from(item.get("path")?.as_str()?),
                    success: item.get("success")?.as_u64()? as usize,
                    failed: item.get("failed")?.as_u64()? as usize,
                    below_target: item
                        .get("belowTarget")
                        .and_then(|value| value.as_u64())
                        .unwrap_or(0) as usize,
                })
            })
            .collect::<Vec<_>>();
        if let Ok(mut session) = state.session.lock() {
            session.history = items;
        }
    }
    // job 编号跨启动去重：新任务的编号必须大于历史里已有的最大编号，
    // 否则重启后 job1 会与上一会话的 job1 混淆。
    if let (Ok(session), Ok(mut next)) = (state.session.lock(), state.next_job.lock()) {
        let max = session
            .history
            .iter()
            .filter_map(|item| item.id.strip_prefix("job")?.parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        *next = (*next).max(max + 1);
    }
    // 恢复上次自选的输出目录：目录仍存在且不是链接时生效，否则忽略。
    if let Some(value) = read_versioned(&dir, "output-v1.json", "path") {
        if let Some(path) = value.as_str() {
            let path = PathBuf::from(path);
            let usable = fs::symlink_metadata(&path)
                .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
                .unwrap_or(false);
            if usable {
                if let Ok(canonical) = fs::canonicalize(&path) {
                    if let Ok(mut session) = state.session.lock() {
                        session.grants.set_output(canonical);
                    }
                }
            }
        }
    }
    prune_clipboard_cache(&dir.join("clipboard"), 20);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = fs::create_dir_all(&dir);
                if let Ok(mut slot) = app.state::<AppState>().data_dir.lock() {
                    *slot = dir;
                }
            }
            load_disk_state(app.state::<AppState>().inner());
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
                        paths, ..
                    }) = event
                    {
                        let state = handle.state::<AppState>();
                        if let Ok(mut session) = state.session.lock() {
                            // 拖入的目录就地展开为图片文件；目录里的导出目录排除，
                            // 展不开的项记录错误，由 import_paths 转成失败记录上报。
                            let recursive = session.settings.recursive_folders;
                            let exclude = session
                                .grants
                                .output
                                .as_ref()
                                .map(|grant| grant.path.clone());
                            let mut expanded: Vec<PathBuf> = Vec::new();
                            let mut errors: Vec<String> = Vec::new();
                            for path in paths.iter() {
                                let is_dir = fs::symlink_metadata(path)
                                    .map(|metadata| metadata.is_dir())
                                    .unwrap_or(false);
                                if is_dir {
                                    for item in
                                        grant::collect_files(path, recursive, exclude.as_deref())
                                    {
                                        match item {
                                            Ok(path) => expanded.push(path),
                                            Err(message) => errors.push(message),
                                        }
                                    }
                                } else {
                                    expanded.push(path.clone());
                                }
                            }
                            session.dropped_paths =
                                expanded.into_iter().take(model::MAX_IMPORT).collect();
                            session.dropped_errors = errors.into_iter().take(20).collect();
                        };
                    }
                });
                let _ = window_fit::fit_to_work_area(&window);
                let _ = window.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_status,
            pick_images,
            pick_folder,
            import_paths,
            import_clipboard,
            remove_files,
            pick_output,
            current_output,
            clear_output,
            file_preview,
            file_evidence,
            preview_export,
            start_export,
            pause_job,
            resume_job,
            cancel_job,
            open_output,
            export_preview,
            export_thumb,
            export_reveal,
            export_copy,
            load_settings,
            save_settings,
            list_history,
            clear_history,
            save_draft,
            load_draft
        ])
        .run(tauri::generate_context!())
        .expect("纯钧无法启动，请检查桌面运行环境。");
}

#[cfg(test)]
mod authorization_tests {
    use super::*;

    #[test]
    fn renderer_paths_require_a_native_drop_and_are_consumed_once() {
        let state = AppState::new();
        let mut session = state.session.lock().unwrap();
        let path = PathBuf::from("audit-sample.png");
        assert!(take_dropped_paths(&mut session, vec![path.to_string_lossy().into()]).is_err());
        session.dropped_paths.insert(path.clone());
        assert!(take_dropped_paths(&mut session, vec!["not-dropped.png".into()]).is_err());
        assert_eq!(
            take_dropped_paths(&mut session, vec![path.to_string_lossy().into()]).unwrap(),
            vec![path.clone()]
        );
        assert!(take_dropped_paths(&mut session, vec![path.to_string_lossy().into()]).is_err());
    }
}

#[cfg(test)]
mod task_and_storage_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "chunjun-lib-{tag}-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn cancelling_while_paused_stops_instead_of_taking_the_next_item() {
        assert_eq!(worker_gate(false, false), WorkerGate::Run);
        assert_eq!(worker_gate(true, false), WorkerGate::Wait);
        // 暂停中收到取消：必须停止，不能领下一项。
        assert_eq!(worker_gate(true, true), WorkerGate::Stop);
        assert_eq!(worker_gate(false, true), WorkerGate::Stop);
    }

    #[test]
    fn reported_fraction_never_goes_backwards() {
        let ceiling = Mutex::new(0.0f64);
        assert_eq!(monotonic_fraction(&ceiling, 0.4), 0.4);
        // 瞬时回跳（并发计数非原子）被历史最大值压住。
        assert_eq!(monotonic_fraction(&ceiling, 0.25), 0.4);
        assert_eq!(monotonic_fraction(&ceiling, 0.9), 0.9);
    }

    #[test]
    fn settings_survive_a_crash_style_write_and_corrupt_files_are_kept() {
        let dir = temp_dir("settings");
        let stored = serde_json::json!({"version": 1, "settings": Settings::default()});
        atomic_write(
            &dir,
            "settings-v1.json",
            &serde_json::to_vec_pretty(&stored).unwrap(),
        )
        .unwrap();
        // 包络格式读取。
        let value = read_versioned(&dir, "settings-v1.json", "settings").unwrap();
        assert!(serde_json::from_value::<Settings>(value).is_ok());
        // 损坏：留档 + 返回 None，原名字文件不再存在（保存会写新文件，旧字节留在留档里）。
        fs::write(dir.join("settings-v1.json"), b"{ not json").unwrap();
        assert!(read_versioned(&dir, "settings-v1.json", "settings").is_none());
        let kept: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("settings-v1.json.corrupt-"))
            .collect();
        assert_eq!(kept.len(), 1, "损坏字节必须留档而不是被覆盖掉");
        // 旧版裸格式兼容读取。
        fs::write(
            dir.join("settings-v1.json"),
            serde_json::to_vec_pretty(&Settings::default()).unwrap(),
        )
        .unwrap();
        let legacy = read_versioned(&dir, "settings-v1.json", "settings").unwrap();
        assert!(serde_json::from_value::<Settings>(legacy).is_ok());
        // 原子写中途失败不破坏旧文件：目录变成文件后 create_dir_all 报错，旧内容仍在。
        let inner = dir.join("blocked");
        fs::write(&inner, b"file blocks the dir").unwrap();
        let err = atomic_write(&inner, "x.json", b"new");
        assert!(err.is_err());
        assert_eq!(fs::read(&inner).unwrap(), b"file blocks the dir");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_envelope_reads_legacy_arrays_too() {
        let dir = temp_dir("history");
        let legacy = serde_json::json!([
            {"id": "job7", "label": "导出", "path": "C:/x", "success": 3, "failed": 0, "belowTarget": 0}
        ]);
        fs::write(
            dir.join("history-v1.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();
        let value = read_versioned(&dir, "history-v1.json", "items").unwrap();
        assert_eq!(value.as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_import_cap_stops_new_files_with_a_visible_record() {
        let state = AppState::new();
        let mut session = state.session.lock().unwrap();
        for index in 0..model::MAX_IMPORT {
            session.grants.insert(
                PathBuf::from(format!("C:/img-{index}.png")),
                Kind::Png,
                FileRecord {
                    id: String::new(),
                    name: format!("img-{index}.png"),
                    format: "PNG".into(),
                    width: 1,
                    height: 1,
                    bytes: 1,
                    status: "ready".into(),
                    message: String::new(),
                    animated: false,
                    pages: 1,
                    has_alpha: false,
                },
            );
        }
        let record = import_path(&mut session, PathBuf::from("C:/one-more.png"));
        assert_eq!(record.status, "failed");
        assert!(record.message.contains("上限"), "{}", record.message);
    }

    #[test]
    fn cancelled_jobs_report_how_many_items_were_never_started() {
        let items = vec![ExportItem {
            id: "f1".into(),
            name: "a.png".into(),
            state: "success".into(),
            message: String::new(),
            output_name: "a.png".into(),
            output_path: "C:/out/a.png".into(),
            bytes: 10,
            source_bytes: 20,
            saved_bytes: 10,
        }];
        let report = summarize("job1", &items, None, 3);
        assert_eq!(report.success, 1);
        assert_eq!(report.cancelled, 3);
    }

    #[test]
    fn job_ids_restart_above_the_highest_persisted_one() {
        let dir = temp_dir("jobid");
        let stored = serde_json::json!({
            "version": 1,
            "items": [
                {"id": "job7", "label": "a", "path": "C:/a", "success": 1, "failed": 0, "belowTarget": 0},
                {"id": "job12", "label": "b", "path": "C:/b", "success": 2, "failed": 0, "belowTarget": 0}
            ]
        });
        fs::write(
            dir.join("history-v1.json"),
            serde_json::to_vec_pretty(&stored).unwrap(),
        )
        .unwrap();
        let state = AppState::new();
        *state.data_dir.lock().unwrap() = dir.clone();
        load_disk_state(&state);
        assert_eq!(*state.next_job.lock().unwrap(), 13);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clipboard_cache_keeps_only_the_newest_copies() {
        let dir = temp_dir("clip");
        let clipboard = dir.join("clipboard");
        fs::create_dir_all(&clipboard).unwrap();
        for index in 0..25 {
            let path = clipboard.join(format!("clipboard-{index}.png"));
            fs::write(&path, b"png").unwrap();
            let stamp =
                std::time::SystemTime::now() - std::time::Duration::from_secs(100 - index as u64);
            let file = fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(stamp).unwrap();
        }
        prune_clipboard_cache(&clipboard, 20);
        let names: Vec<String> = fs::read_dir(&clipboard)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 20, "只保留最近 20 份缓存副本");
        assert!(names.contains(&"clipboard-24.png".to_string()));
        assert!(!names.contains(&"clipboard-0.png".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod job_stress_tests {
    use super::*;
    use std::io::Cursor;

    /// 记录型任务环境：收集事件、历史与清理记录；可选在完成第 N 项后置取消，
    /// 模拟用户中途取消。
    struct RecordingContext {
        events: Mutex<Vec<JobEvent>>,
        remembered: Mutex<Vec<(ExportReport, PathBuf)>>,
        forgotten: Mutex<Vec<String>>,
        cancel_after: Option<(Arc<JobShared>, usize)>,
    }

    impl JobContext for RecordingContext {
        fn emit(&self, event: &JobEvent) {
            if event.kind == "item" {
                if let Some((job, after)) = &self.cancel_after {
                    if event.done >= *after {
                        job.cancel.store(true, Ordering::Relaxed);
                    }
                }
            }
            self.events.lock().unwrap().push(event.clone());
        }
        fn remember(&self, report: &ExportReport, directory: PathBuf) {
            self.remembered
                .lock()
                .unwrap()
                .push((report.clone(), directory));
        }
        fn forget(&self, job_id: &str) {
            self.forgotten.lock().unwrap().push(job_id.to_string());
        }
    }

    fn write_source(path: &Path, kind: Kind, index: usize) {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(24, 18, |x, y| {
            image::Rgb([(x as u8 + index as u8) % 251, (y as u8 * 3) % 251, 90])
        }));
        let format = match kind {
            Kind::Jpeg => image::ImageFormat::Jpeg,
            Kind::Png => image::ImageFormat::Png,
            Kind::Webp => image::ImageFormat::WebP,
            Kind::Bmp => image::ImageFormat::Bmp,
            Kind::Gif => image::ImageFormat::Gif,
            Kind::Tiff => image::ImageFormat::Tiff,
            _ => image::ImageFormat::Png,
        };
        if kind == Kind::Svg {
            let text = format!(
                r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18"><rect width="24" height="18" fill="#{index:06x}"/></svg>"##
            );
            fs::write(path, text).unwrap();
            return;
        }
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), format)
            .expect("测试源图编码失败");
        fs::write(path, bytes).unwrap();
    }

    fn stress_dir(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "chunjun-stress-{tag}-{}-{unique}",
            std::process::id(),
            unique = unique_suffix()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn make_tasks(dir: &Path, count: usize) -> (Vec<Task>, Vec<PathBuf>) {
        let formats = [
            Kind::Jpeg,
            Kind::Png,
            Kind::Webp,
            Kind::Bmp,
            Kind::Gif,
            Kind::Tiff,
            Kind::Svg,
        ];
        let mut tasks = Vec::new();
        let mut sources = Vec::new();
        for index in 0..count {
            let kind = formats[index % formats.len()];
            let extension = match kind {
                Kind::Jpeg => "jpg",
                Kind::Png => "png",
                Kind::Webp => "webp",
                Kind::Bmp => "bmp",
                Kind::Gif => "gif",
                Kind::Tiff => "tiff",
                Kind::Svg => "svg",
                _ => "bin",
            };
            let path = dir.join(format!("源-{index:03}.{extension}"));
            write_source(&path, kind, index);
            sources.push(path.clone());
            tasks.push(Task {
                id: format!("t{index}"),
                source: path,
                name: format!("源-{index:03}.{extension}"),
                kind,
                edit: Edit::default(),
                mark: None,
                failure: None,
            });
        }
        (tasks, sources)
    }

    #[test]
    fn hundred_mixed_images_finish_with_monotonic_progress() {
        let dir = stress_dir("100");
        let (tasks, _sources) = make_tasks(&dir, 100);
        let output = dir.join("导出");
        fs::create_dir_all(&output).unwrap();
        let job = Arc::new(JobShared {
            pause: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            tasks,
            output: Some(output.clone()),
            write_report: true,
            protected_sources: Vec::new(),
        });
        let ctx = RecordingContext {
            events: Mutex::new(Vec::new()),
            remembered: Mutex::new(Vec::new()),
            forgotten: Mutex::new(Vec::new()),
            cancel_after: None,
        };
        run_job_with(&ctx, "job100".into(), Arc::clone(&job), 2);
        let events = ctx.events.lock().unwrap();
        let done = events
            .iter()
            .rev()
            .find(|event| event.kind == "done")
            .expect("应有 done 事件");
        assert_eq!(done.done, 100);
        let report = done.report.as_ref().unwrap();
        let failed: Vec<(String, String)> = report
            .items
            .iter()
            .filter(|item| item.state == "failed")
            .map(|item| (item.name.clone(), item.message.clone()))
            .collect();
        assert_eq!(report.success + report.below_target, 100, "{failed:?}");
        assert_eq!(report.cancelled, 0);
        // 进度事件流（含 item/paused）必须单调不回退。
        let mut highest = 0.0f64;
        for event in events.iter() {
            if matches!(event.kind.as_str(), "progress" | "item" | "paused") {
                assert!(
                    event.fraction + 1e-9 >= highest,
                    "进度回退：{highest} -> {}",
                    event.fraction
                );
                highest = highest.max(event.fraction);
            }
        }
        // 100 张副本 + 1 份来源报告，编号不覆盖。
        let files: Vec<_> = fs::read_dir(&output)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(files.len(), 101, "{files:?}");
        // 结束后清理注册表、记入历史。
        assert_eq!(*ctx.forgotten.lock().unwrap(), vec!["job100".to_string()]);
        assert_eq!(ctx.remembered.lock().unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelling_mid_job_keeps_finished_copies_and_counts_the_rest() {
        let dir = stress_dir("cancel");
        let (tasks, _sources) = make_tasks(&dir, 40);
        let output = dir.join("导出");
        fs::create_dir_all(&output).unwrap();
        let job = Arc::new(JobShared {
            pause: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            tasks,
            output: Some(output.clone()),
            write_report: false,
            protected_sources: Vec::new(),
        });
        let ctx = RecordingContext {
            events: Mutex::new(Vec::new()),
            remembered: Mutex::new(Vec::new()),
            forgotten: Mutex::new(Vec::new()),
            cancel_after: Some((Arc::clone(&job), 6)),
        };
        run_job_with(&ctx, "jobc".into(), job, 1);
        let events = ctx.events.lock().unwrap();
        let done = events
            .iter()
            .rev()
            .find(|event| event.kind == "done")
            .unwrap();
        let report = done.report.as_ref().unwrap();
        assert!(report.items.len() >= 6, "取消前至少完成触发行");
        assert_eq!(report.cancelled, 40 - report.items.len());
        assert!(done.phase.contains("未执行"), "{}", done.phase);
        // 已完成项的副本都在磁盘上；未执行项没有写任何文件。
        for item in &report.items {
            assert!(
                fs::metadata(&item.output_path).is_ok(),
                "{} 应存在",
                item.output_path
            );
        }
        let written: Vec<_> = fs::read_dir(&output)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(written.len(), report.success + report.below_target);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_output_directory_exports_are_remembered_for_reopening() {
        let dir = stress_dir("defaulthistory");
        let (tasks, sources) = make_tasks(&dir, 2);
        let source_dir = sources[0].parent().unwrap().to_path_buf();
        let job = Arc::new(JobShared {
            pause: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            tasks,
            output: None,
            write_report: false,
            protected_sources: Vec::new(),
        });
        let ctx = RecordingContext {
            events: Mutex::new(Vec::new()),
            remembered: Mutex::new(Vec::new()),
            forgotten: Mutex::new(Vec::new()),
            cancel_after: None,
        };
        run_job_with(&ctx, "jobd".into(), job, 1);
        let remembered = ctx.remembered.lock().unwrap();
        let (_, directory) = remembered.first().unwrap();
        assert_eq!(directory, &source_dir.join("纯钧导出"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persisted_output_directory_is_restored_and_stale_ones_ignored() {
        let dir = stress_dir("outputstate");
        let state = AppState::new();
        *state.data_dir.lock().unwrap() = dir.clone();
        // 记录一个仍然存在的目录：恢复为当前输出目录。
        let live = dir.join("仍存在");
        fs::create_dir_all(&live).unwrap();
        let stored = serde_json::json!({"version": 1, "path": live.clone()});
        atomic_write(
            &dir,
            "output-v1.json",
            &serde_json::to_vec_pretty(&stored).unwrap(),
        )
        .unwrap();
        load_disk_state(&state);
        {
            let session = state.session.lock().unwrap();
            let output = session.grants.output.as_ref().unwrap();
            assert_eq!(
                fs::canonicalize(&output.path).unwrap(),
                fs::canonicalize(&live).unwrap()
            );
        }
        // 记录一个已消失的目录：忽略，不报错也不设输出目录。
        let gone = serde_json::json!({"version": 1, "path": dir.join("已消失")});
        atomic_write(
            &dir,
            "output-v1.json",
            &serde_json::to_vec_pretty(&gone).unwrap(),
        )
        .unwrap();
        let state = AppState::new();
        *state.data_dir.lock().unwrap() = dir.clone();
        load_disk_state(&state);
        assert!(state.session.lock().unwrap().grants.output.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_recording_off_hides_entries_without_deleting_them() {
        let state = AppState::new();
        {
            let mut session = state.session.lock().unwrap();
            session.history.push(StoredHistory {
                id: "job1".into(),
                label: "导出".into(),
                path: PathBuf::from("C:/out"),
                success: 3,
                failed: 0,
                below_target: 0,
            });
        }
        // 关闭：list_history_inner 不再列出，但数据保留。
        {
            let mut session = state.session.lock().unwrap();
            session.settings.history_enabled = false;
            assert!(list_history_inner(&session).is_empty());
            assert_eq!(session.history.len(), 1, "已保存的数据不能被删");
        }
        // 重新打开：条目恢复显示。
        let mut session = state.session.lock().unwrap();
        session.settings.history_enabled = true;
        assert_eq!(list_history_inner(&session).len(), 1);
    }

    #[test]
    fn oversized_clipboard_images_are_refused_with_a_reason() {
        assert!(clipboard_budget(6000, 6000, 6000 * 6000 * 4).is_ok());
        assert!(clipboard_budget(7000, 7000, 160 * 1024 * 1024 + 1).is_err());
        let error = clipboard_budget(8000, 8000, 100).unwrap_err();
        assert!(error.contains("像素上限"), "{error}");
        let error = clipboard_budget(10, 10, 200 * 1024 * 1024).unwrap_err();
        assert!(error.contains("160MB"), "{error}");
    }
}
