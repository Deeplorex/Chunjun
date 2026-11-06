export type WorkspaceName = 'compress' | 'convert' | 'crop' | 'mark';

export interface FileRecord {
  id: string;
  name: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  status: string;
  message: string;
  animated: boolean;
  pages: number;
  hasAlpha: boolean;
}

export interface AigcFields {
  label: string;
  contentProducer: string;
  produceId: string;
  reservedCode1: string;
  contentPropagator: string;
  propagateId: string;
  reservedCode2: string;
}

export interface Evidence {
  aigc: AigcFields | null;
  auxiliary: string[];
  c2pa: {
    present: boolean;
    signature: string;
    trust: string;
    remote: string;
  };
  icc: string;
  orientation: number;
  copyright: string;
  notes: string[];
  /** 可迁移 EXIF 条目数（IFD0 + Exif 子 IFD），0 表示未发现。 */
  exifFields: number;
  /** 是否存在 XMP 包。 */
  hasXmp: boolean;
  /** 是否存在 PNG 文本块（含 AIGC 文本声明）。 */
  hasTextChunks: boolean;
  /** 是否存在 PNG 色彩块（gAMA/sRGB 等）。 */
  hasColorChunks: boolean;
}

export interface EditDraft {
  metadataOnly: boolean;
  quality: number;
  targetKb: number;
  minQuality: number;
  keepSmaller: boolean;
  skipIfBelowTarget: boolean;
  scaleMode: 'keep' | 'long' | 'percent';
  longEdge: number;
  percent: number;
  allowUpscale: boolean;
  outputFormat: 'keep' | 'jpeg' | 'png' | 'webp' | 'avif';
  background: string;
  pngLossy: boolean;
  frameIndex: number;
  keepAnimation: boolean;
  useCrop: boolean;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  straighten: number;
  cover: boolean;
  coverX: number;
  coverY: number;
  coverW: number;
  coverH: number;
  coverColor: string;
  cropAway: boolean;
  watermark: boolean;
  watermarkText: string;
  watermarkImageId: string;
  watermarkMode: 'single' | 'center' | 'tile';
  anchor: string;
  opacity: number;
  angle: number;
  gap: number;
  fontSize: number;
  watermarkColor: string;
  margin: number;
  metadataPolicy:
    'keep' | 'addGeneric' | 'addAigc' | 'replaceAigc' | 'deleteFields';
  /** 用户确认丢弃目标格式无法承载的元数据后置真；Rust 仍是最终门禁。 */
  allowMetadataLoss: boolean;
  producer: string;
  author: string;
  copyright: string;
  description: string;
  aigcLabel: '1' | '2' | '3';
  deleteFields: string[];
  prefix: string;
  suffix: string;
  conflict: 'number' | 'skip' | 'replace';
  svgWidth: number;
}

export interface PreviewImage {
  pngBase64: string;
  width: number;
  height: number;
}

export interface PreviewExport {
  pngBase64: string;
  width: number;
  height: number;
  encodedBytes: number;
  belowTarget: boolean;
  message: string;
}

export interface ExportItem {
  id: string;
  name: string;
  state: string;
  message: string;
  outputName: string;
  outputPath: string;
  bytes: number;
  sourceBytes: number;
  savedBytes: number;
}

export interface ExportReport {
  jobId: string;
  success: number;
  skipped: number;
  failed: number;
  belowTarget: number;
  /** 取消时未执行的任务数；正常结束为 0。 */
  cancelled: number;
  savedBytes: number;
  items: ExportItem[];
  outputLabel: string;
}

export interface Settings {
  concurrency: number;
  historyEnabled: boolean;
  recursiveFolders: boolean;
  conflict: 'number' | 'skip' | 'replace';
  prefix: string;
  suffix: string;
}

export interface HistoryItem {
  id: string;
  label: string;
  success: number;
  failed: number;
  belowTarget: number;
}

export interface JobEvent {
  kind: string;
  jobId: string;
  done: number;
  total: number;
  name: string;
  phase: string;
  /** 整体完成度 0..1；并发时由后端按各图阶段加权得出。 */
  fraction: number;
  item?: ExportItem;
  report?: ExportReport;
}

export interface OutputInfo {
  id: string;
  label: string;
}

export interface DraftView {
  files: FileRecord[];
  document: string;
}

export interface DesktopClient {
  available: boolean;
  status(): Promise<string>;
  pickImages(): Promise<FileRecord[]>;
  pickFolder(recursive: boolean): Promise<FileRecord[]>;
  importPaths(paths: string[]): Promise<FileRecord[]>;
  importClipboard(): Promise<FileRecord[]>;
  removeFiles(ids: string[]): Promise<void>;
  pickOutput(): Promise<OutputInfo | null>;
  /** 启动时恢复的上次自选输出目录；没有则为 null。 */
  currentOutput(): Promise<OutputInfo | null>;
  clearOutput(): Promise<void>;
  filePreview(id: string): Promise<PreviewImage>;
  fileEvidence(id: string): Promise<Evidence>;
  previewExport(id: string, edit: EditDraft): Promise<PreviewExport>;
  startExport(
    files: { id: string; edit: EditDraft }[],
    writeReport: boolean,
    onEvent: (event: JobEvent) => void,
  ): Promise<ExportReport>;
  pauseJob(jobId: string): Promise<void>;
  resumeJob(jobId: string): Promise<void>;
  cancelJob(jobId: string): Promise<void>;
  openOutput(jobId?: string): Promise<void>;
  exportPreview(jobId: string, fileId: string): Promise<PreviewImage>;
  exportThumb(jobId: string, fileId: string): Promise<string>;
  exportReveal(jobId: string, fileId: string): Promise<void>;
  exportCopy(jobId: string, fileId: string): Promise<void>;
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  listHistory(): Promise<HistoryItem[]>;
  clearHistory(): Promise<void>;
  saveDraft(ids: string[], document: string): Promise<void>;
  loadDraft(): Promise<DraftView>;
  listenForDrops?(onDrop: (paths: string[]) => void): Promise<() => void>;
}

export function defaultEdit(): EditDraft {
  return {
    metadataOnly: false,
    quality: 80,
    targetKb: 0,
    minQuality: 40,
    keepSmaller: true,
    skipIfBelowTarget: false,
    scaleMode: 'keep',
    longEdge: 1920,
    percent: 100,
    allowUpscale: false,
    outputFormat: 'keep',
    background: '#FFFFFF',
    pngLossy: true,
    frameIndex: 0,
    keepAnimation: false,
    useCrop: false,
    cropX: 0,
    cropY: 0,
    cropW: 0,
    cropH: 0,
    rotation: 0,
    flipH: false,
    flipV: false,
    straighten: 0,
    cover: false,
    coverX: 0,
    coverY: 0,
    coverW: 0,
    coverH: 0,
    coverColor: '#F7F7F3',
    cropAway: false,
    watermark: false,
    watermarkText: '',
    watermarkImageId: '',
    watermarkMode: 'single',
    anchor: 'se',
    opacity: 48,
    angle: -30,
    gap: 48,
    fontSize: 28,
    watermarkColor: '#252E29',
    margin: 24,
    metadataPolicy: 'keep',
    allowMetadataLoss: false,
    producer: '',
    author: '',
    copyright: '',
    description: '',
    aigcLabel: '1',
    deleteFields: [],
    prefix: '',
    suffix: '_纯钧',
    conflict: 'number',
    svgWidth: 1024,
  };
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
