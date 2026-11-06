import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type {
  DesktopClient,
  DraftView,
  EditDraft,
  Evidence,
  ExportReport,
  FileRecord,
  HistoryItem,
  JobEvent,
  OutputInfo,
  PreviewExport,
  PreviewImage,
  Settings,
} from './types';

function browserOnly(): never {
  throw new Error('浏览器仅供界面预览，请使用桌面窗口处理图片。');
}

async function command<T>(name: string, args?: Record<string, unknown>) {
  if (!isTauri()) browserOnly();
  return invoke<T>(name, args);
}

export const desktop: DesktopClient = {
  available: isTauri(),
  async status() {
    if (!isTauri()) browserOnly();
    return invoke<string>('app_status');
  },
  pickImages: () => command<FileRecord[]>('pick_images'),
  pickFolder: (recursive) =>
    command<FileRecord[]>('pick_folder', { recursive }),
  importPaths: (paths) => command<FileRecord[]>('import_paths', { paths }),
  importClipboard: () => command<FileRecord[]>('import_clipboard'),
  removeFiles: (ids) => command<void>('remove_files', { ids }),
  pickOutput: () => command<OutputInfo | null>('pick_output'),
  currentOutput: () => command<OutputInfo | null>('current_output'),
  clearOutput: () => command<void>('clear_output'),
  filePreview: (id) => command<PreviewImage>('file_preview', { id }),
  fileEvidence: (id) => command<Evidence>('file_evidence', { id }),
  previewExport: (id, edit) =>
    command<PreviewExport>('preview_export', { id, edit }),
  async startExport(files, writeReport, onEvent) {
    if (!isTauri()) browserOnly();
    const buffered: JobEvent[] = [];
    let jobId = '';
    let unlisten: UnlistenFn = () => {};
    try {
      return await new Promise<ExportReport>((resolve, reject) => {
        void listen<JobEvent>('chunjun-job', (event) => {
          const payload = event.payload;
          if (!jobId) {
            buffered.push(payload);
            return;
          }
          if (payload.jobId !== jobId) return;
          onEvent(payload);
          if (payload.kind === 'done') {
            if (payload.report) resolve(payload.report);
            else reject(new Error('任务结束时没有结果'));
          }
        })
          .then((stop) => {
            unlisten = stop;
            return invoke<string>('start_export', { files, writeReport });
          })
          .then((id) => {
            jobId = id;
            for (const payload of buffered) {
              if (payload.jobId !== jobId) continue;
              onEvent(payload);
              if (payload.kind === 'done') {
                if (payload.report) resolve(payload.report);
                else reject(new Error('任务结束时没有结果'));
              }
            }
          })
          .catch(reject);
      });
    } finally {
      unlisten();
    }
  },
  pauseJob: (jobId) => command<void>('pause_job', { jobId }),
  resumeJob: (jobId) => command<void>('resume_job', { jobId }),
  cancelJob: (jobId) => command<void>('cancel_job', { jobId }),
  openOutput: (jobId) => command<void>('open_output', { jobId }),
  exportPreview: (jobId, fileId) =>
    command<PreviewImage>('export_preview', { jobId, fileId }),
  exportThumb: (jobId, fileId) =>
    command<string>('export_thumb', { jobId, fileId }),
  exportReveal: (jobId, fileId) =>
    command<void>('export_reveal', { jobId, fileId }),
  exportCopy: (jobId, fileId) =>
    command<void>('export_copy', { jobId, fileId }),
  loadSettings: () => command<Settings>('load_settings'),
  saveSettings: (settings) => command<void>('save_settings', { settings }),
  listHistory: () => command<HistoryItem[]>('list_history'),
  clearHistory: () => command<void>('clear_history'),
  saveDraft: (ids, document) => command<void>('save_draft', { ids, document }),
  loadDraft: () => command<DraftView>('load_draft'),
  async listenForDrops(onDrop) {
    if (!isTauri()) return () => {};
    const webview = getCurrentWebview();
    return webview.onDragDropEvent((event) => {
      if (event.payload.type === 'drop') onDrop(event.payload.paths);
    });
  },
};

export type { EditDraft };
