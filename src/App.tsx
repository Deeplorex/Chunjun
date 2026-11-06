import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useMemo,
} from 'react';
import { Icon } from './components/Icon';
import { ScrollArea } from './components/ScrollArea';
import {
  ExportOptions,
  ExportNamingFields,
  ExportConfirmation,
} from './components/ExportOptions';
import { desktop } from './platform/desktop';
import {
  setTaskbarProgress,
  taskbarProgress,
  watchMaximized,
  windowAction,
} from './platform/window';
import {
  defaultEdit,
  formatBytes,
  type DesktopClient,
  type EditDraft,
  type Evidence,
  type ExportItem,
  type ExportReport,
  type FileRecord,
  type HistoryItem,
  type PreviewImage,
  type Settings,
  type WorkspaceName,
} from './platform/types';

type Surface = 'tool' | 'settings' | 'history';
type MarkPane = 'meta' | 'visible';
type MarkAction = 'read' | 'remove' | 'rewrite';
type Tone = 'info' | 'warn';

interface ResultPreview {
  fileId: string;
  url: string;
  bytes: number;
  belowTarget: boolean;
  message: string;
}

interface Notice {
  text: string;
  tone: Tone;
}

type ExportFile = { id: string; edit: EditDraft };
interface ExportReview {
  payload: ExportFile[];
  warnings: string[];
  blockers: string[];
}

const workspaces: { name: WorkspaceName; label: string; icon: string }[] = [
  { name: 'compress', label: '图片压缩', icon: 'compress' },
  { name: 'convert', label: '格式转换', icon: 'convert' },
  { name: 'crop', label: '裁剪尺寸', icon: 'crop' },
  { name: 'mark', label: '水印与声明', icon: 'scan' },
];

const labelText: Record<string, string> = {
  '1': '属于 AI 生成合成',
  '2': '可能为 AI 生成合成',
  '3': '疑似为 AI 生成合成',
};

const aigcFields: { key: keyof NonNullable<Evidence['aigc']>; name: string }[] =
  [
    { key: 'label', name: 'Label' },
    { key: 'contentProducer', name: 'ContentProducer' },
    { key: 'produceId', name: 'ProduceID' },
    { key: 'contentPropagator', name: 'ContentPropagator' },
    { key: 'propagateId', name: 'PropagateID' },
    { key: 'reservedCode1', name: 'ReservedCode1' },
    { key: 'reservedCode2', name: 'ReservedCode2' },
  ];

const anchors: [string, string][] = [
  ['nw', '左上'],
  ['n', '上'],
  ['ne', '右上'],
  ['w', '左'],
  ['center', '中'],
  ['e', '右'],
  ['sw', '左下'],
  ['s', '下'],
  ['se', '右下'],
];

const watermarkTemplates: {
  label: string;
  text: string;
  mode: EditDraft['watermarkMode'];
  opacity: number;
}[] = [
  {
    label: '证件复印件',
    text: '仅供办理开户使用，他用无效',
    mode: 'tile',
    opacity: 40,
  },
  {
    label: '仅限本次办理',
    text: '仅限本次办理使用，再次复印无效',
    mode: 'tile',
    opacity: 36,
  },
  {
    label: '版权归属',
    text: '版权归属 © 纯钧用户',
    mode: 'single',
    opacity: 60,
  },
  { label: '自定义', text: '', mode: 'tile', opacity: 40 },
];

function formatLabel(edit: EditDraft, files: FileRecord[] = []) {
  if (edit.metadataOnly) return '原容器（仅改元数据）';
  if (edit.outputFormat === 'keep')
    return files.some((file) =>
      ['bmp', 'tiff', 'gif', 'svg'].includes(file.format.toLowerCase()),
    )
      ? '可编码格式保留；其余转 PNG'
      : '保持原格式';
  return edit.outputFormat.toUpperCase();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function ratioOf(width: number, height: number) {
  if (!width || !height) return '自由';
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.01) return '1 : 1';
  if (Math.abs(ratio - 1.5) < 0.01) return '3 : 2';
  if (Math.abs(ratio - 16 / 9) < 0.01) return '16 : 9';
  if (Math.abs(ratio - 4 / 3) < 0.01) return '4 : 3';
  return `${width} : ${height}`;
}

/// 内置平台清单只做快捷填入：名称是用户声明，编号仍由纯钧生成。
const AIGC_PRODUCERS = [
  '即梦/豆包',
  '通义万相/千问',
  '混元',
  '文心',
  '可灵/可图',
  'ChatGPT',
  'Gemini',
  'Adobe Firefly',
  'Midjourney',
];

function savedPercent(source: number, output: number) {
  if (!source || !output || output >= source) return '—';
  return `${(((source - output) / source) * 100).toFixed(1)}%`;
}

export default function App({ client = desktop }: { client?: DesktopClient }) {
  const [status, setStatus] = useState(
    client.available ? '正在连接桌面框架…' : '浏览器框架预览',
  );
  const [error, setError] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceName>('compress');
  const [surface, setSurface] = useState<Surface>('tool');
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [edit, setEdit] = useState<EditDraft>(defaultEdit);
  const [drafts, setDrafts] = useState<Record<string, EditDraft>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<{
    id: string;
    value: Evidence;
  } | null>(null);
  const [result, setResult] = useState<ResultPreview | null>(null);
  const [notice, setNotice] = useState<Notice>({
    text: '',
    tone: 'info',
  });
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [jobId, setJobId] = useState('');
  const [progress, setProgress] = useState({
    done: 0,
    total: 0,
    name: '',
    stage: '',
    fraction: 0,
  });
  const [liveItems, setLiveItems] = useState<ExportItem[]>([]);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [outputLabel, setOutputLabel] = useState('原目录 / 纯钧导出');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [settings, setSettings] = useState<Settings>({
    concurrency: 1,
    historyEnabled: true,
    recursiveFolders: false,
    conflict: 'number',
    prefix: '',
    suffix: '_纯钧',
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [saveState, setSaveState] = useState<
    'pending' | 'saving' | 'saved' | 'failed'
  >(client.available ? 'pending' : 'saved');
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [compare, setCompare] = useState(50);
  const [view, setView] = useState<'original' | 'result' | 'compare'>(
    'compare',
  );
  const [markPane, setMarkPane] = useState<MarkPane>('meta');
  const [markAction, setMarkAction] = useState<MarkAction>('read');
  const [openAfterExport, setOpenAfterExport] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [exportOptionsOpen, setExportOptionsOpen] = useState(false);
  const [checkingExport, setCheckingExport] = useState(false);
  const [exportReview, setExportReview] = useState<ExportReview | null>(null);
  const exportBusy = useRef(false);
  /** 最近一次导出实际提交的参数快照；失败重试沿用它，不吃工作区当前改动。 */
  const lastExportPayload = useRef<ExportFile[] | null>(null);

  const acceptRef = useRef<(task: Promise<FileRecord[]>) => void>(() => {});
  const requestedThumbs = useRef(new Set<string>());
  const previewEpoch = useRef(0);
  // 参数每变一次自增；异步结果回来时对不上就丢弃，避免过期预览覆盖新参数。
  const resultEpoch = useRef(0);
  const undoRef = useRef<{ key: string; edit: EditDraft }[]>([]);
  const redoRef = useRef<{ key: string; edit: EditDraft }[]>([]);
  const resultRef = useRef<ResultPreview | null>(null);

  const selected = files.find((file) => file.id === selectedId) ?? null;
  const perFile = workspace === 'crop' || workspace === 'mark';
  const scopeKey = `${workspace}:${selected?.id ?? ''}`;
  const [resetScope, setResetScope] = useState(scopeKey);
  if (resetScope !== scopeKey) {
    setResetScope(scopeKey);
    undoRef.current = [];
    redoRef.current = [];
    setView('compare');
  }
  const currentEdit =
    perFile && selected ? (drafts[selected.id] ?? edit) : edit;
  const readyFiles = useMemo(
    () => files.filter((file) => file.status === 'ready' && file.id),
    [files],
  );
  const readyCount = readyFiles.length;
  const sourceUrl = selected ? (previews[selected.id] ?? '') : '';
  const currentResult =
    result && selected && result.fileId === selected.id ? result : null;
  const saved =
    selected && currentResult
      ? savedPercent(selected.bytes, currentResult.bytes)
      : '—';
  const targets = exportTargets(readyFiles);
  const showStart =
    surface === 'tool' &&
    workspace === 'compress' &&
    files.length === 0 &&
    !running;
  const showWork = surface === 'tool' && !running && !showStart;
  const marking = workspace === 'mark';

  const heading = pageHeading({
    surface,
    workspace,
    showStart,
    running,
  });
  const aigc =
    evidence && selected && evidence.id === selected.id
      ? evidence.value.aigc
      : null;
  const selectedEvidence =
    evidence && selected && evidence.id === selected.id ? evidence.value : null;

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    let active = true;
    if (!client.available) return;
    client
      .status()
      .then((value) => {
        if (!active) return;
        if (value === 'ready') setStatus('桌面框架连接就绪');
        else {
          setStatus('桌面框架返回未知状态');
          setError(true);
        }
      })
      .catch(() => {
        if (active) {
          setStatus('桌面连接失败，请重新启动开发窗口。');
          setError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (!client.available) return;
    let active = true;
    void Promise.all([client.loadSettings(), client.listHistory()])
      .then(([loaded, items]) => {
        if (!active) return;
        if (loaded) {
          setSettings(loaded);
          setEdit((current) => ({
            ...current,
            conflict: loaded.conflict ?? 'number',
            prefix: loaded.prefix ?? '',
            suffix: loaded.suffix ?? '_纯钧',
          }));
        }
        setHistory(items ?? []);
        setSettingsLoaded(true);
      })
      .catch(() => {
        if (active) {
          setSaveState('failed');
          setNotice({
            text: '设置或历史未能读取，已停止自动保存，请重新启动后重试。',
            tone: 'warn',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (!client.available) return;
    let active = true;
    void client
      .currentOutput()
      .then((output) => {
        if (active && output) setOutputLabel(output.label);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (!client.available || !settingsLoaded) return;
    // 历史开关一变就同步列表：关闭不展示、重开即恢复，不需要重启。
    void client
      .listHistory()
      .then((items) => setHistory(items ?? []))
      .catch(() => {});
  }, [client, settingsLoaded, settings.historyEnabled]);

  useEffect(() => {
    if (!client.available || !settingsLoaded) return;
    const timer = window.setTimeout(() => {
      setSaveState('saving');
      void client
        .saveSettings(settings)
        .then(() => setSaveState('saved'))
        .catch(() => {
          setSaveState('failed');
          setNotice({
            text: '设置没有保存成功，请检查本机数据目录。',
            tone: 'warn',
          });
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [client, settings, settingsLoaded]);

  useEffect(() => {
    if (!client.available || !client.listenForDrops) return;
    let stop = () => {};
    void client
      .listenForDrops((paths) => {
        acceptRef.current(client.importPaths(paths));
      })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => {});
    return () => stop();
  }, [client]);

  useEffect(
    () => () => {
      previewEpoch.current += 1;
      requestedThumbs.current.clear();
    },
    [client],
  );

  useEffect(() => {
    if (!client.available) return;
    const epoch = previewEpoch.current;
    for (const file of readyFiles) {
      if (requestedThumbs.current.has(file.id) || previews[file.id]) continue;
      requestedThumbs.current.add(file.id);
      void client
        .filePreview(file.id)
        .then((image) => {
          if (previewEpoch.current !== epoch) return;
          setPreviews((current) =>
            current[file.id]
              ? current
              : {
                  ...current,
                  [file.id]: `data:image/png;base64,${image.pngBase64}`,
                },
          );
        })
        .catch(() => {
          requestedThumbs.current.delete(file.id);
        });
    }
  }, [client, readyFiles, previews]);

  useEffect(() => {
    if (!client.available || !selected?.id || selected.status !== 'ready')
      return;
    let active = true;
    void client
      .fileEvidence(selected.id)
      .then((value) => active && setEvidence({ id: selected.id, value }))
      .catch(() => active && setEvidence(null));
    return () => {
      active = false;
    };
  }, [client, selected?.id, selected?.status]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (exportReview) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName),
      );
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void addImages();
      } else if (
        modifier &&
        event.key.toLowerCase() === 'z' &&
        !event.shiftKey &&
        !typing
      ) {
        event.preventDefault();
        undo();
      } else if (
        (modifier && event.shiftKey && event.key.toLowerCase() === 'z') ||
        (modifier && event.key.toLowerCase() === 'y')
      ) {
        if (typing) return;
        event.preventDefault();
        redo();
      } else if (event.key === 'Escape' && exportOptionsOpen) {
        setExportOptionsOpen(false);
        document
          .querySelector<HTMLButtonElement>('[aria-controls="export-options"]')
          ?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function applyEdit(next: EditDraft, remember = true) {
    if (remember) {
      undoRef.current = [
        ...undoRef.current.slice(-30),
        { key: scopeKey, edit: currentEdit },
      ];
      redoRef.current = [];
      resultEpoch.current += 1;
    }
    if (perFile && selected) {
      setDrafts((current) => ({ ...current, [selected.id]: next }));
    } else {
      setEdit(next);
    }
    setResult(null);
  }

  function undo() {
    const previous = undoRef.current.at(-1);
    if (!previous || previous.key !== scopeKey) return;
    undoRef.current = undoRef.current.slice(0, -1);
    redoRef.current = [
      ...redoRef.current.slice(-30),
      { key: scopeKey, edit: currentEdit },
    ];
    if (perFile && selected) {
      setDrafts((current) => ({ ...current, [selected.id]: previous.edit }));
    } else {
      setEdit(previous.edit);
    }
    setResult(null);
  }

  function redo() {
    const next = redoRef.current.at(-1);
    if (!next || next.key !== scopeKey) return;
    redoRef.current = redoRef.current.slice(0, -1);
    undoRef.current = [
      ...undoRef.current.slice(-30),
      { key: scopeKey, edit: currentEdit },
    ];
    if (perFile && selected) {
      setDrafts((current) => ({ ...current, [selected.id]: next.edit }));
    } else {
      setEdit(next.edit);
    }
    setResult(null);
  }

  async function accept(task: Promise<FileRecord[]>) {
    if (!client.available) {
      setNotice({
        text: '浏览器仅供界面预览，请使用桌面窗口处理图片。',
        tone: 'warn',
      });
      return;
    }
    try {
      const imported = await task;
      if (imported.length === 0) return;
      const repeat = imported.filter((file) => file.message === '重复项已跳过');
      const added = imported.filter((file) => file.message !== '重复项已跳过');
      if (added.length > 0) {
        setFiles((current) => [...current, ...added]);
        const firstReady = added.find(
          (file) => file.status === 'ready' && file.id,
        );
        if (firstReady) setSelectedId((current) => current || firstReady.id);
      }
      const failed = added.filter((file) => file.status !== 'ready').length;
      if (added.length === 0) {
        setNotice({
          text: `已跳过 ${repeat.length} 个重复文件。`,
          tone: 'info',
        });
        return;
      }
      setNotice({
        text: failed
          ? `已加入 ${added.length} 项，其中 ${failed} 项需要查看原因。`
          : `已加入 ${added.length} 项。`,
        tone: failed ? 'warn' : 'info',
      });
    } catch (reason) {
      setNotice({
        text: reason instanceof Error ? reason.message : '导入失败',
        tone: 'warn',
      });
    }
  }
  acceptRef.current = accept;

  function addImages() {
    return accept(client.pickImages());
  }

  function chooseOutput() {
    if (!client.available) {
      setNotice({
        text: '浏览器仅供界面预览，请使用桌面窗口设置导出目录。',
        tone: 'warn',
      });
      return;
    }
    void client
      .pickOutput()
      .then((output) => {
        if (!output) return;
        setOutputLabel(output.label);
        setNotice({ text: `导出目录：${output.label}`, tone: 'info' });
      })
      .catch((reason: Error) => {
        setNotice({ text: reason.message, tone: 'warn' });
      });
  }

  function saveWorkspaceDraft() {
    if (!client.available) {
      setNotice({
        text: '浏览器仅供界面预览，请使用桌面窗口保存草稿。',
        tone: 'warn',
      });
      return;
    }
    const ids = files.filter((file) => file.id).map((file) => file.id);
    if (ids.length === 0) {
      setNotice({ text: '先导入图片，再保存工作区草稿。', tone: 'warn' });
      return;
    }
    const document = JSON.stringify({
      version: 1,
      workspace,
      edit,
      drafts,
      markAction,
    });
    void client
      .saveDraft(ids, document)
      .then(() => {
        setNotice({
          text: `已保存草稿：${ids.length} 张图片与当前参数。`,
          tone: 'info',
        });
      })
      .catch((reason: Error) => {
        setNotice({ text: reason.message, tone: 'warn' });
      });
  }

  async function restoreWorkspaceDraft() {
    if (!client.available) {
      setNotice({
        text: '浏览器仅供界面预览，请使用桌面窗口恢复草稿。',
        tone: 'warn',
      });
      return;
    }
    try {
      const view = await client.loadDraft();
      const added = view.files.filter(
        (file) =>
          file.message !== '重复项已跳过' && file.status === 'ready' && file.id,
      );
      if (view.files.length === 0 && !view.document) {
        setNotice({ text: '还没有可恢复的草稿。', tone: 'info' });
        return;
      }
      if (added.length > 0) {
        setFiles((current) => [...current, ...added]);
        const first = added[0];
        setSelectedId((current) => current || first.id);
      }
      if (view.document) {
        try {
          const parsed = JSON.parse(view.document) as {
            version?: number;
            workspace?: WorkspaceName;
            edit?: EditDraft;
            drafts?: Record<string, EditDraft>;
            markAction?: MarkAction;
          };
          if (parsed.version === 1) {
            if (parsed.edit) setEdit(parsed.edit);
            if (parsed.drafts) setDrafts(parsed.drafts);
            if (parsed.markAction) setMarkAction(parsed.markAction);
            if (parsed.workspace) setWorkspace(parsed.workspace);
          }
        } catch {
          // 草稿正文损坏：文件列表照常恢复，参数保持现状并提示。
          setNotice({
            text: '草稿参数部分已损坏，仅恢复了图片列表。',
            tone: 'warn',
          });
          return;
        }
      }
      setNotice({
        text: added.length
          ? `已恢复草稿：${added.length} 张图片与保存时的参数。`
          : '已恢复草稿参数；图片已在列表中或源文件已移动。',
        tone: 'info',
      });
    } catch (reason) {
      setNotice({
        text: reason instanceof Error ? reason.message : '草稿恢复失败',
        tone: 'warn',
      });
    }
  }

  function removeSelected() {
    if (!selected?.id) return;
    const index = files.findIndex((file) => file.id === selected.id);
    const remaining = files.filter((file) => file.id !== selected.id);
    void client.removeFiles([selected.id]).catch(() => {});
    setFiles(remaining);
    setSelectedId(remaining[Math.min(index, remaining.length - 1)]?.id ?? '');
    setResult(null);
  }

  function editFor(fileId: string) {
    const per = drafts[fileId];
    if (!per) return edit;
    // 跨工作区组合：裁剪/水印/声明是逐图字段，随这张图的草稿走；
    // 压缩/转换等全局参数跟随当前工作区，不固化到草稿里。
    return mergePerFile(edit, per);
  }

  function processingEdit(draft: EditDraft): EditDraft {
    return {
      ...draft,
      metadataOnly: workspace === 'mark' && markPane === 'meta',
    };
  }

  async function requestExport(
    list: FileRecord[] = targets,
    snapshot?: ExportFile[],
  ) {
    if (exportBusy.current || running) return;
    if (!client.available) {
      setNotice({
        text: '浏览器仅供界面预览，请使用桌面窗口导出。',
        tone: 'warn',
      });
      return;
    }
    const chosen = list.filter((file) => file.status === 'ready' && file.id);
    if (chosen.length === 0) {
      setNotice({ text: '先导入可处理的图片。', tone: 'warn' });
      return;
    }
    if (
      markAction === 'remove' &&
      marking &&
      currentEdit.deleteFields.length === 0
    ) {
      setNotice({ text: '先选择要删除的声明字段。', tone: 'warn' });
      return;
    }
    // 重试走快照：沿用失败任务当时的参数，不吃当前工作区的新改动；
    // 快照里已不存在的文件自动跳过，顺序与 chosen 对齐。
    const payload = snapshot
      ? chosen.flatMap((file) => {
          const entry = snapshot.find((item) => item.id === file.id);
          return entry ? [entry] : [];
        })
      : chosen.map((file) => ({
          id: file.id,
          edit: {
            ...processingEdit(editFor(file.id)),
            conflict: edit.conflict,
            prefix: edit.prefix,
            suffix: edit.suffix,
          },
        }));
    exportBusy.current = true;
    setCheckingExport(true);
    try {
      const evidenceList = await Promise.all(
        chosen.map((file) => client.fileEvidence(file.id)),
      );
      const warnings: string[] = [],
        blockers: string[] = [];
      chosen.forEach((file, index) => {
        const draft = payload[index].edit,
          source = evidenceList[index];
        if (!draft.metadataOnly) {
          const format =
            draft.outputFormat === 'keep'
              ? ['bmp', 'tiff', 'gif', 'svg'].includes(
                  file.format.toLowerCase(),
                )
                ? 'png' // 这些源没有对应编码器，保持原格式时实际输出 PNG
                : file.format.toLowerCase()
              : draft.outputFormat;
          const multiple = file.animated || file.pages > 1;
          if (multiple && !draft.keepAnimation) {
            const frame = draft.frameIndex || 1;
            warnings.push(
              `${file.name}：只导出第 ${frame} ${file.animated ? '帧' : '页'}，其余${file.animated ? '动画帧' : '页面'}不会写入副本。`,
            );
            payload[index].edit = { ...draft, frameIndex: frame };
          }
          if (
            file.hasAlpha &&
            format === 'jpeg' &&
            !(multiple && draft.keepAnimation)
          )
            warnings.push(
              `${file.name}：JPEG 不支持透明，透明区域将填充为 ${draft.background}。`,
            );
          if (
            multiple &&
            draft.keepAnimation &&
            (draft.useCrop ||
              draft.rotation ||
              draft.flipH ||
              draft.flipV ||
              draft.straighten ||
              draft.cover ||
              draft.cropAway ||
              draft.watermark ||
              draft.scaleMode !== 'keep' ||
              (draft.outputFormat !== 'keep' &&
                format !== file.format.toLowerCase()))
          )
            blockers.push(
              `${file.name}：保留完整动画或多页原件时，不能同时裁剪、绘制水印或转换格式。请先调整参数。`,
            );
          if (!(multiple && draft.keepAnimation)) {
            // JPEG/PNG 目标已支持容器迁移；其余目标承载不了的字段须逐项确认丢弃。
            const carriable: string[] = [];
            if (source.exifFields > 0) carriable.push('EXIF 拍摄信息');
            if (source.icc === '存在') carriable.push('ICC 色彩配置');
            if (source.hasXmp || source.aigc || source.copyright)
              carriable.push('XMP 声明');
            const canCarry = format === 'jpeg' || format === 'png';
            const uncarrivable: string[] = [];
            if (source.hasTextChunks) uncarrivable.push('PNG 文本字段');
            if (source.hasColorChunks) uncarrivable.push('PNG 色彩块');
            if (canCarry && format === 'jpeg' && uncarrivable.length)
              warnings.push(
                `${file.name}：${uncarrivable.join('、')}无法写入 JPEG 副本，确认后将丢弃；改用 PNG 目标可完整保留。`,
              );
            else if (!canCarry && (carriable.length || uncarrivable.length))
              warnings.push(
                `${file.name}：${[...carriable, ...uncarrivable].join('、')}无法写入 ${format.toUpperCase()} 副本，确认后将丢弃；改用 JPEG/PNG 可完整迁移。`,
              );
            if (
              (canCarry && format === 'jpeg' && uncarrivable.length) ||
              (!canCarry && (carriable.length || uncarrivable.length))
            )
              payload[index].edit = {
                ...payload[index].edit,
                allowMetadataLoss: true,
              };
            if (!canCarry && source.orientation !== 1)
              warnings.push(
                `${file.name}：方向 ${source.orientation} 将烘焙为正向像素，不随副本携带。`,
              );
            if (source.c2pa.present)
              warnings.push(
                `${file.name}：原件含未验证的 C2PA 字节线索，重编码后内容凭证不随副本保留。`,
              );
            if (draft.metadataPolicy !== 'keep' && source.hasXmp)
              warnings.push(
                `${file.name}：原件含 XMP，若其中有未支持的未知字段，导出将被拒绝以防声明丢失。`,
              );
          }
        }
        if (draft.metadataPolicy !== 'keep')
          warnings.push(
            `${file.name}：${draft.metadataPolicy === 'deleteFields' ? `将删除声明字段 ${draft.deleteFields.join('、')}。` : draft.metadataPolicy === 'replaceAigc' ? '将替换现有 AIGC 声明，写入纯钧生成的本地编号。' : '将补充文件内声明；用户填写的来源名称未经核验。'}`,
          );
      });
      setCheckingExport(false);
      if (warnings.length || blockers.length)
        setExportReview({ payload, warnings, blockers });
      else await runExport(payload);
    } catch {
      exportBusy.current = false;
      setCheckingExport(false);
      setNotice({
        text: '导出前检查失败，尚未写入文件。请重试。',
        tone: 'warn',
      });
    }
  }

  async function runExport(payload: ExportFile[]) {
    if (!client.available || payload.length === 0 || running) return;
    lastExportPayload.current = payload;
    setExportOptionsOpen(false);
    setSurface('tool');
    setRunning(true);
    setPaused(false);
    setReport(null);
    setProgress({
      done: 0,
      total: payload.length,
      name: files.find((file) => file.id === payload[0]?.id)?.name ?? '',
      stage: '准备处理',
      fraction: 0,
    });
    setLiveItems([]);
    setNotice({ text: `正在处理 0/${payload.length}`, tone: 'info' });
    try {
      const next = await client.startExport(payload, true, (event) => {
        if (event.jobId) setJobId(event.jobId);
        // 任务栏进度与界面进度同源：正常推进、暂停置灰，结束/失败清除。
        if (event.kind === 'progress' || event.kind === 'paused') {
          void setTaskbarProgress(
            taskbarProgress(event.fraction, event.kind === 'paused'),
          );
        }
        if (event.kind === 'progress') {
          setProgress({
            done: event.done,
            total: event.total,
            name: event.name,
            stage: event.phase,
            fraction: event.fraction,
          });
          setNotice({
            text: `${event.phase || '正在处理'} · ${Math.min(event.done + 1, event.total)}/${event.total}：${event.name}`,
            tone: 'info',
          });
        }
        if (event.kind === 'item' && event.item) {
          const finished = event.item;
          setLiveItems((current) => [...current, finished]);
          setProgress({
            done: event.done,
            total: event.total,
            name: event.name,
            stage: '',
            fraction: event.fraction,
          });
          if (finished.state === 'failed') {
            setNotice({
              text: `${finished.name} 失败：${finished.message}`,
              tone: 'warn',
            });
          }
        }
        if (event.kind === 'paused') setPaused(true);
      });
      setReport(next);
      setSurface('history');
      setNotice({
        text: `成功 ${next.success}，未达标 ${next.belowTarget}，跳过 ${next.skipped}，失败 ${next.failed}${next.cancelled ? `，${next.cancelled} 项因取消未执行` : ''}。未达标不会记成成功。`,
        tone:
          next.failed > 0 || next.belowTarget > 0 || next.cancelled > 0
            ? 'warn'
            : 'info',
      });
      if (openAfterExport) {
        setOpenAfterExport(false);
        void client.openOutput(next.jobId).catch(() => {});
      }
      void client
        .listHistory()
        .then(setHistory)
        .catch(() => {});
    } catch (reason) {
      setNotice({
        text: reason instanceof Error ? reason.message : '导出失败',
        tone: 'warn',
      });
    } finally {
      exportBusy.current = false;
      setRunning(false);
      setPaused(false);
      setJobId('');
      void setTaskbarProgress({ kind: 'none' });
    }
  }

  async function previewResult() {
    if (!selected || selected.status !== 'ready') {
      setNotice({ text: '先选择一张可处理的图片。', tone: 'warn' });
      return;
    }
    if (previewing) return;
    setPreviewing(true);
    setNotice({ text: '正在按当前参数生成预览…', tone: 'info' });
    const epoch = resultEpoch.current;
    try {
      const next = await client.previewExport(
        selected.id,
        processingEdit(editFor(selected.id)),
      );
      if (resultEpoch.current !== epoch) {
        // 参数在预览期间被改过：这份结果是旧的，丢弃并提示重新生成。
        setNotice({
          text: '参数已修改，刚才的预览已过期，请重新生成。',
          tone: 'warn',
        });
        return;
      }
      setResult({
        fileId: selected.id,
        url: `data:image/png;base64,${next.pngBase64}`,
        bytes: next.encodedBytes,
        belowTarget: next.belowTarget,
        message: next.message,
      });
      setView((current) => (current === 'original' ? 'compare' : current));
      setNotice({
        text: `${next.message || '已完成当前图片预览。'} 结果体积 ${formatBytes(next.encodedBytes)}${next.belowTarget ? '，未达到目标体积。' : '。'}`,
        tone: next.belowTarget ? 'warn' : 'info',
      });
    } catch (reason) {
      setNotice({
        text: reason instanceof Error ? reason.message : '预览失败',
        tone: 'warn',
      });
    } finally {
      setPreviewing(false);
    }
  }

  function switchMarkAction(action: MarkAction) {
    setMarkAction(action);
    setNotice({ text: '', tone: 'info' });
    if (action === 'remove') {
      const fields = selectedEvidence?.aigc
        ? aigcFields
            .filter((field) => String(selectedEvidence.aigc?.[field.key] ?? ''))
            .map((field) => field.name)
        : [];
      applyEdit({
        ...currentEdit,
        metadataPolicy: 'deleteFields',
        deleteFields: fields,
      });
      if (fields.length === 0) {
        setNotice({
          text: '这份文件没有读到可删除的 AIGC 声明。',
          tone: 'warn',
        });
      }
    }
    if (action === 'rewrite')
      applyEdit({ ...currentEdit, metadataPolicy: 'addAigc' });
    if (action === 'read')
      applyEdit({ ...currentEdit, metadataPolicy: 'keep', deleteFields: [] });
  }

  function applyCropToAll() {
    if (!selected) return;
    const base = selected;
    const rotationPatch = {
      rotation: currentEdit.rotation,
      flipH: currentEdit.flipH,
      flipV: currentEdit.flipV,
      straighten: currentEdit.straighten,
      allowUpscale: currentEdit.allowUpscale,
      scaleMode: currentEdit.scaleMode,
      longEdge: currentEdit.longEdge,
      percent: currentEdit.percent,
    };
    const hasFrame =
      currentEdit.useCrop && currentEdit.cropW > 0 && currentEdit.cropH > 0;
    const ratio = hasFrame
      ? {
          x: currentEdit.cropX / base.width,
          y: currentEdit.cropY / base.height,
          w: currentEdit.cropW / base.width,
          h: currentEdit.cropH / base.height,
        }
      : null;
    setDrafts((current) => {
      const updated = { ...current };
      for (const file of readyFiles) {
        const draft = { ...(updated[file.id] ?? edit), ...rotationPatch };
        if (ratio) {
          const x = clamp(
            Math.round(ratio.x * file.width),
            0,
            Math.max(0, file.width - 1),
          );
          const y = clamp(
            Math.round(ratio.y * file.height),
            0,
            Math.max(0, file.height - 1),
          );
          draft.useCrop = true;
          draft.cropX = x;
          draft.cropY = y;
          draft.cropW = clamp(
            Math.round(ratio.w * file.width),
            1,
            file.width - x,
          );
          draft.cropH = clamp(
            Math.round(ratio.h * file.height),
            1,
            file.height - y,
          );
        } else {
          draft.useCrop = false;
        }
        updated[file.id] = draft;
      }
      return updated;
    });
    setNotice({
      text: `已按比例把当前裁剪与旋转参数应用到 ${readyCount} 张图片。`,
      tone: 'info',
    });
  }

  function resetCrop() {
    applyEdit({
      ...currentEdit,
      useCrop: false,
      cropX: 0,
      cropY: 0,
      cropW: 0,
      cropH: 0,
      rotation: 0,
      flipH: false,
      flipV: false,
      straighten: 0,
      allowUpscale: false,
    });
  }

  function toggleDeleteField(name: string) {
    const fields = currentEdit.deleteFields.includes(name)
      ? currentEdit.deleteFields.filter((field) => field !== name)
      : [...currentEdit.deleteFields, name];
    applyEdit({
      ...currentEdit,
      metadataPolicy: 'deleteFields',
      deleteFields: fields,
    });
  }

  const actionSummary = summaryFor({
    workspace,
    markPane,
    markAction,
    files,
    readyFiles,
    targets,
    selected,
    currentEdit,
    result: currentResult,
    saved,
    aigc,
    outputLabel,
  });

  const primaryLabel =
    workspace === 'crop'
      ? '应用并继续'
      : marking && markPane === 'visible'
        ? '导出当前图片'
        : marking && markAction === 'remove'
          ? '导出删除后的副本'
          : marking
            ? `保存 ${readyCount} 张副本`
            : `导出 ${targets.length} 张图片`;

  const exportDisabled =
    !client.available ||
    targets.length === 0 ||
    running ||
    checkingExport ||
    (marking &&
      markAction === 'remove' &&
      currentEdit.deleteFields.length === 0);

  const liveText = notice.text;

  return (
    <>
      <div className="app-frame" inert={Boolean(exportReview)}>
        <TitleBar available={client.available} />
        <div className="app-body">
          <aside className="navigation" aria-label="工具导航">
            <nav className="nav-group">
              {workspaces.map((item) => (
                <button
                  key={item.name}
                  className="nav-item"
                  type="button"
                  aria-current={
                    surface === 'tool' && workspace === item.name
                      ? 'page'
                      : undefined
                  }
                  onClick={() => {
                    setSurface('tool');
                    setWorkspace(item.name);
                    setResult(null);
                    setNotice({ text: '', tone: 'info' });
                  }}
                >
                  <Icon name={item.icon} />
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="nav-divider" />
            <button
              className="nav-link"
              type="button"
              aria-current={surface === 'history' ? 'page' : undefined}
              onClick={() => {
                setSurface('history');
                if (client.available) {
                  void client
                    .listHistory()
                    .then(setHistory)
                    .catch(() => {});
                }
              }}
            >
              <Icon name="history" size={18} />
              处理记录
            </button>
            <div className="nav-foot">
              <button
                className="nav-link"
                type="button"
                aria-current={surface === 'settings' ? 'page' : undefined}
                onClick={() => setSurface('settings')}
              >
                <Icon name="settings" size={18} />
                设置
              </button>
            </div>
          </aside>
          <main className="workspace">
            <header className="workspace-heading">
              <h2>{heading.title}</h2>
              {marking && surface === 'tool' && !showStart && (
                <Segmented
                  className="heading-switch"
                  value={markPane}
                  options={[
                    { value: 'meta', label: '元数据声明' },
                    { value: 'visible', label: '明水印' },
                  ]}
                  onChange={(value) => setMarkPane(value as MarkPane)}
                />
              )}
            </header>
            {(error || (showStart && notice.tone === 'warn')) && (
              <p className="app-alert" role="alert">
                {error ? status : notice.text}
              </p>
            )}

            {surface === 'settings' ? (
              <SettingsPage
                settings={settings}
                onChange={(next) => {
                  setSaveState('pending');
                  setSettings(next);
                }}
                edit={{
                  ...edit,
                  prefix: settings.prefix,
                  suffix: settings.suffix,
                  conflict: settings.conflict,
                }}
                onEdit={(next) => {
                  setSaveState('pending');
                  setSettings((current) => ({
                    ...current,
                    prefix: next.prefix,
                    suffix: next.suffix,
                    conflict: next.conflict,
                  }));
                  setEdit((current) => ({
                    ...current,
                    prefix: next.prefix,
                    suffix: next.suffix,
                    conflict: next.conflict,
                  }));
                }}
                outputLabel={outputLabel}
                onOutput={chooseOutput}
                saveState={saveState}
                available={client.available}
                onBack={() => setSurface('tool')}
                onSaveDraft={saveWorkspaceDraft}
                onRestoreDraft={restoreWorkspaceDraft}
                onClearHistory={() => {
                  if (!client.available) return;
                  void client
                    .clearHistory()
                    .then(() => {
                      setHistory([]);
                      setNotice({
                        text: '本机历史已清除，源文件和已导出副本仍在。',
                        tone: 'info',
                      });
                    })
                    .catch((reason: Error) =>
                      setNotice({ text: reason.message, tone: 'warn' }),
                    );
                }}
                onClearPreview={() => {
                  previewEpoch.current += 1;
                  setPreviews({});
                  requestedThumbs.current.clear();
                  setResult(null);
                  setNotice({ text: '预览已从内存清掉。', tone: 'info' });
                }}
              />
            ) : surface === 'history' && !running ? (
              <HistoryPage
                report={report}
                history={history}
                onOpen={(id) => {
                  if (client.available)
                    void client.openOutput(id).catch(() => {});
                }}
                onRetry={() => {
                  // 失败与未达标都重试，且沿用导出时的参数快照。
                  const retryIds = new Set(
                    (report?.items ?? [])
                      .filter(
                        (item) =>
                          item.state === 'failed' ||
                          item.state === 'below_target',
                      )
                      .map((item) => item.id),
                  );
                  if (retryIds.size === 0) return;
                  const snapshot =
                    lastExportPayload.current?.filter((entry) =>
                      retryIds.has(entry.id),
                    ) ?? [];
                  void requestExport(
                    files.filter((file) => retryIds.has(file.id)),
                    snapshot.length > 0 ? snapshot : undefined,
                  );
                }}
                onAdd={() => {
                  setSurface('tool');
                  setWorkspace('compress');
                  void addImages();
                }}
                onBack={() => setSurface('tool')}
                onOutput={chooseOutput}
                onPreview={(jobId, fileId) =>
                  client.exportPreview(jobId, fileId)
                }
                historyEnabled={settings.historyEnabled}
                onThumb={(jobId, fileId) => client.exportThumb(jobId, fileId)}
                onCopy={(jobId, fileId) => client.exportCopy(jobId, fileId)}
                onReveal={(jobId, fileId) => client.exportReveal(jobId, fileId)}
              />
            ) : running ? (
              <ProgressPage
                progress={progress}
                items={liveItems}
                paused={paused}
                notice={notice}
                outputLabel={outputLabel}
                canControl={Boolean(jobId)}
                onPause={() => {
                  if (jobId) void client.pauseJob(jobId).catch(() => {});
                  setPaused(true);
                }}
                onResume={() => {
                  if (jobId) void client.resumeJob(jobId).catch(() => {});
                  setPaused(false);
                }}
                onCancel={() => {
                  if (jobId) void client.cancelJob(jobId).catch(() => {});
                }}
                onHistory={() => setSurface('history')}
                onOutput={chooseOutput}
              />
            ) : showStart ? (
              <StartPage
                onImages={() => void addImages()}
                onFolder={() =>
                  void accept(client.pickFolder(settings.recursiveFolders))
                }
                onPaste={() => void accept(client.importClipboard())}
              />
            ) : (
              <div className={`work ${showWork ? '' : 'idle'}`}>
                <FileRail
                  files={files}
                  selectedId={selectedId}
                  thumbs={previews}
                  readyCount={readyCount}
                  onSelect={(id) => {
                    setSelectedId(id);
                    setResult(null);
                  }}
                  onAdd={() => void addImages()}
                />
                <Stage
                  workspace={workspace}
                  markPane={markPane}
                  markAction={markAction}
                  file={selected}
                  source={sourceUrl}
                  result={currentResult}
                  evidence={selectedEvidence}
                  view={view}
                  zoom={zoom}
                  compare={compare}
                  edit={currentEdit}
                  onView={setView}
                  onZoom={setZoom}
                  onCompare={setCompare}
                  onCrop={(crop) =>
                    applyEdit({ ...currentEdit, useCrop: true, ...crop })
                  }
                  onImages={() => void addImages()}
                  onFolder={() =>
                    void accept(client.pickFolder(settings.recursiveFolders))
                  }
                  onPaste={() => void accept(client.importClipboard())}
                />
                <Inspector
                  workspace={workspace}
                  markPane={markPane}
                  markAction={markAction}
                  file={selected}
                  edit={currentEdit}
                  files={files}
                  evidence={selectedEvidence}
                  aigc={aigc}
                  readyCount={readyCount}
                  result={currentResult}
                  onEdit={applyEdit}
                  onPreview={() => void previewResult()}
                  previewing={previewing}
                  onMarkPane={setMarkPane}
                  onMarkAction={switchMarkAction}
                  onDeleteField={toggleDeleteField}
                  onApplyAll={applyCropToAll}
                  onReset={resetCrop}
                  onRemove={removeSelected}
                />
                <div className="export-dock">
                  {exportOptionsOpen && (
                    <ExportOptions
                      edit={processingEdit({
                        ...currentEdit,
                        prefix: edit.prefix,
                        suffix: edit.suffix,
                        conflict: edit.conflict,
                      })}
                      outputLabel={outputLabel}
                      onOutput={chooseOutput}
                      onResetOutput={() => {
                        void client
                          .clearOutput()
                          .then(() => setOutputLabel('原目录 / 纯钧导出'))
                          .catch(() =>
                            setNotice({
                              text: '无法恢复默认目录，请重试。',
                              tone: 'warn',
                            }),
                          );
                      }}
                      onNaming={(patch) =>
                        setEdit((current) => ({ ...current, ...patch }))
                      }
                      onFormat={(outputFormat) =>
                        applyEdit({ ...currentEdit, outputFormat })
                      }
                      openAfter={openAfterExport}
                      onOpenAfter={setOpenAfterExport}
                      onClose={() => {
                        setExportOptionsOpen(false);
                        document
                          .querySelector<HTMLButtonElement>(
                            '[aria-controls="export-options"]',
                          )
                          ?.focus();
                      }}
                    />
                  )}
                  <ActionBar
                    summary={actionSummary.summary}
                    sub="源文件保持只读。"
                    location={{ label: outputLabel, onClick: chooseOutput }}
                    notice={notice}
                    onViewHistory={
                      report ? () => setSurface('history') : undefined
                    }
                    secondary="导出设置"
                    secondaryExpanded={exportOptionsOpen}
                    secondaryControls="export-options"
                    onSecondary={() => setExportOptionsOpen((open) => !open)}
                    primary={checkingExport ? '正在检查…' : primaryLabel}
                    primaryDisabled={exportDisabled}
                    onPrimary={() => void requestExport()}
                  />
                </div>
              </div>
            )}

            {!showStart ? (
              <span className="sr-only" role="status" aria-live="polite">
                {liveText}
              </span>
            ) : null}
          </main>
        </div>
      </div>
      {exportReview && (
        <ExportConfirmation
          warnings={exportReview.warnings}
          blockers={exportReview.blockers}
          onCancel={() => {
            setExportReview(null);
            exportBusy.current = false;
          }}
          onConfirm={() => {
            const payload = exportReview.payload;
            setExportReview(null);
            void runExport(payload);
          }}
        />
      )}
    </>
  );
}

/** 跨工作区组合：裁剪/水印/声明是逐图字段，随这张图的草稿走；
 * 压缩/转换等其余参数全局共享，导出与预览都按这份组合执行。 */
function mergePerFile(base: EditDraft, per: EditDraft): EditDraft {
  return {
    ...base,
    useCrop: per.useCrop,
    cropX: per.cropX,
    cropY: per.cropY,
    cropW: per.cropW,
    cropH: per.cropH,
    rotation: per.rotation,
    flipH: per.flipH,
    flipV: per.flipV,
    straighten: per.straighten,
    cover: per.cover,
    coverX: per.coverX,
    coverY: per.coverY,
    coverW: per.coverW,
    coverH: per.coverH,
    coverColor: per.coverColor,
    cropAway: per.cropAway,
    watermark: per.watermark,
    watermarkText: per.watermarkText,
    watermarkImageId: per.watermarkImageId,
    watermarkMode: per.watermarkMode,
    anchor: per.anchor,
    opacity: per.opacity,
    angle: per.angle,
    gap: per.gap,
    fontSize: per.fontSize,
    watermarkColor: per.watermarkColor,
    margin: per.margin,
    metadataPolicy: per.metadataPolicy,
    author: per.author,
    copyright: per.copyright,
    description: per.description,
    aigcLabel: per.aigcLabel,
    producer: per.producer,
    deleteFields: per.deleteFields,
  };
}

function exportTargets(ready: FileRecord[]) {
  // 共享工作区：任何工具里导出的都是整个文件列表；没有逐图草稿的图按
  // 当前全局参数处理，有草稿的图把裁剪/水印/声明组合进去。
  return ready;
}

function pageHeading({
  surface,
  workspace,
  showStart,
  running,
}: {
  surface: Surface;
  workspace: WorkspaceName;
  showStart: boolean;
  running: boolean;
}) {
  if (running) return { title: '正在处理' };
  if (surface === 'settings') return { title: '设置' };
  if (surface === 'history') return { title: '处理记录' };
  if (showStart) return { title: '开始处理' };
  if (workspace === 'convert') return { title: '格式转换' };
  if (workspace === 'crop') return { title: '裁剪尺寸' };
  if (workspace === 'mark') return { title: '水印与声明' };
  return { title: '图片压缩' };
}

function summaryFor({
  workspace,
  markPane,
  markAction,
  files,
  readyFiles,
  targets,
  selected,
  currentEdit,
  result,
  saved,
  aigc,
  outputLabel,
}: {
  workspace: WorkspaceName;
  markPane: MarkPane;
  markAction: MarkAction;
  files: FileRecord[];
  readyFiles: FileRecord[];
  targets: FileRecord[];
  selected: FileRecord | null;
  currentEdit: EditDraft;
  result: ResultPreview | null;
  saved: string;
  aigc: Evidence['aigc'] | null;
  outputLabel: string;
}) {
  let summary = `${readyFiles.length} 张可处理`;
  if (workspace === 'compress') {
    summary = result
      ? `已预览 · 当前图片减少 ${saved}`
      : `${readyFiles.length} 张可处理 · 尚未预览`;
  } else if (workspace === 'convert') {
    const alpha = targets.filter((file) => file.hasAlpha).length;
    summary = `${targets.length} 张图片 → ${formatLabel(currentEdit)}${currentEdit.outputFormat === 'jpeg' && alpha ? ` · ${alpha} 张将填充透明背景` : ''}`;
  } else if (workspace === 'crop') {
    const width =
      currentEdit.useCrop && currentEdit.cropW
        ? currentEdit.cropW
        : (selected?.width ?? 0);
    const height =
      currentEdit.useCrop && currentEdit.cropH
        ? currentEdit.cropH
        : (selected?.height ?? 0);
    summary = `当前裁剪：${ratioOf(width, height)} · 输出 ${width || '—'} × ${height || '—'} px`;
  } else if (workspace === 'mark' && markPane === 'visible') {
    summary = currentEdit.watermark
      ? `用途水印已设置 · 仅作用于导出副本`
      : '尚未设置用途水印';
  } else if (workspace === 'mark') {
    if (
      markAction === 'remove' &&
      currentEdit.metadataPolicy === 'deleteFields'
    ) {
      summary = `已选 ${currentEdit.deleteFields.length} 条声明 · 其他元数据保留`;
    } else if (markAction === 'rewrite') {
      summary = `将写入纯钧本地声明 · 共 ${readyFiles.length} 张副本`;
    } else if (aigc) {
      summary = `当前图片已发现声明 · 共 ${files.length} 张`;
    } else if (selected) {
      summary = `当前图片未发现声明 · 共 ${readyFiles.length} 张`;
    } else {
      summary = '尚未添加图片';
    }
  }
  return { summary, sub: `保存到：${outputLabel}。源文件保持只读。` };
}

function TitleBar({ available }: { available: boolean }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void watchMaximized((value) => {
      if (!cancelled) setMaximized(value);
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else stop = cleanup;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <img src="/brand/mark-small.svg" width="20" height="20" alt="" />
      <strong data-tauri-drag-region>纯钧</strong>
      <span data-tauri-drag-region>图片处理</span>
      <div className="window-controls">
        <button
          type="button"
          aria-label="最小化"
          disabled={!available}
          onClick={() => void windowAction('minimize')}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          aria-label={maximized ? '还原' : '最大化'}
          disabled={!available}
          onClick={() => void windowAction('toggleMaximize')}
        >
          <Icon name={maximized ? 'restore' : 'window'} />
        </button>
        <button
          type="button"
          aria-label="关闭"
          className="close"
          disabled={!available}
          onClick={() => void windowAction('close')}
        >
          <Icon name="close" />
        </button>
      </div>
    </header>
  );
}

function StartPage({
  onImages,
  onFolder,
  onPaste,
}: {
  onImages: () => void;
  onFolder: () => void;
  onPaste: () => void;
}) {
  return (
    <ScrollArea as="section" label="开始页" className="start-page">
      <div className="start-inner">
        <h3>把图片处理妥当。</h3>
        <div className="drop-zone">
          <Icon name="image" size={48} />
          <strong>把图片或文件夹拖到这里</strong>
          <button className="text-button" type="button" onClick={onPaste}>
            也可以粘贴剪贴板中的图片
          </button>
          <div className="choice-row">
            <button className="primary" type="button" onClick={onImages}>
              选择图片
            </button>
            <button className="secondary" type="button" onClick={onFolder}>
              选择文件夹
            </button>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}

function FileRail({
  files,
  selectedId,
  thumbs,
  readyCount,
  onSelect,
  onAdd,
}: {
  files: FileRecord[];
  selectedId: string;
  thumbs: Record<string, string>;
  readyCount: number;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <aside className="file-rail">
      <div className="rail-head">
        <strong>文件</strong>
        <span>{files.length} 张</span>
        <button
          className="icon-button"
          type="button"
          aria-label="添加图片"
          onClick={onAdd}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
      <div className="rail-divider" />
      <p className="rail-sub">全部已选 · 共 {readyCount} 张可处理</p>
      <ScrollArea label="文件列表" className="file-list">
        {files.length === 0 && <p className="hint">还没有图片。</p>}
        {files.map((file, index) => (
          <button
            key={`${file.id || file.name}-${index}`}
            type="button"
            className="file-card"
            aria-current={file.id === selectedId}
            onClick={() => onSelect(file.id)}
          >
            {thumbs[file.id] ? (
              <img src={thumbs[file.id]} alt="" />
            ) : (
              <span className="thumb" />
            )}
            <span className="file-meta">
              <strong>{file.name}</strong>
              <small>
                {file.width || '—'} × {file.height || '—'}
              </small>
              <small>
                {file.status === 'ready'
                  ? formatBytes(file.bytes)
                  : file.message || '不能处理'}
              </small>
            </span>
          </button>
        ))}
      </ScrollArea>
    </aside>
  );
}

function Stage({
  workspace,
  markPane,
  markAction,
  file,
  source,
  result,
  evidence,
  view,
  zoom,
  compare,
  edit,
  onView,
  onZoom,
  onCompare,
  onCrop,
  onImages,
  onFolder,
  onPaste,
}: {
  workspace: WorkspaceName;
  markPane: MarkPane;
  markAction: MarkAction;
  file: FileRecord | null;
  source: string;
  result: ResultPreview | null;
  evidence: Evidence | null;
  view: 'original' | 'result' | 'compare';
  zoom: 'fit' | 'actual';
  compare: number;
  edit: EditDraft;
  onView: (view: 'original' | 'result' | 'compare') => void;
  onZoom: (zoom: 'fit' | 'actual') => void;
  onCompare: (value: number) => void;
  onCrop: (crop: {
    cropX: number;
    cropY: number;
    cropW: number;
    cropH: number;
  }) => void;
  onImages: () => void;
  onFolder: () => void;
  onPaste: () => void;
}) {
  if (!file) {
    return (
      <ScrollArea as="section" label="图片预览" className="stage">
        <StartCompact
          onImages={onImages}
          onFolder={onFolder}
          onPaste={onPaste}
        />
      </ScrollArea>
    );
  }
  if (workspace === 'mark' && markPane === 'meta') {
    return (
      <ScrollArea as="section" label="图片预览" className="stage">
        {markAction === 'remove' ? (
          <BeforeAfterStage file={file} edit={edit} evidence={evidence} />
        ) : (
          <EvidenceStage file={file} evidence={evidence} thumb={source} />
        )}
      </ScrollArea>
    );
  }
  return (
    <ScrollArea as="section" label="图片预览" className="stage">
      <div className="stage-toolbar">
        <Segmented
          value={view}
          options={[
            { value: 'original', label: '原图' },
            { value: 'result', label: '处理后' },
            { value: 'compare', label: '对比' },
          ]}
          onChange={(value) =>
            onView(value as 'original' | 'result' | 'compare')
          }
        />
        <div className="zoom">
          <button
            type="button"
            className={zoom === 'fit' ? 'active' : ''}
            onClick={() => onZoom('fit')}
          >
            适应窗口
          </button>
          <span>·</span>
          <button
            type="button"
            className={zoom === 'actual' ? 'active' : ''}
            onClick={() => onZoom('actual')}
          >
            100%
          </button>
        </div>
      </div>
      <div className="stage-caption">
        <strong>{file.name}</strong>
        <span>
          {file.width || '—'} × {file.height || '—'} px
        </span>
      </div>
      <PreviewArea
        file={file}
        source={source}
        result={result}
        view={view}
        zoom={zoom}
        compare={compare}
        onCompare={onCompare}
        crop={workspace === 'crop' ? edit : null}
        onCrop={onCrop}
      />
      {workspace === 'compress' && (
        <div className="metrics">
          <div>
            <span>原始体积</span>
            <strong>{formatBytes(file.bytes)}</strong>
          </div>
          <div>
            <span>处理后</span>
            <strong>{result ? formatBytes(result.bytes) : '尚未预览'}</strong>
          </div>
          <div>
            <span>已减少</span>
            <strong className="accent">
              {result ? savedPercent(file.bytes, result.bytes) : '—'}
            </strong>
          </div>
        </div>
      )}
    </ScrollArea>
  );
}

function PreviewArea({
  file,
  source,
  result,
  view,
  zoom,
  compare,
  onCompare,
  crop,
  onCrop,
}: {
  file: FileRecord;
  source: string;
  result: ResultPreview | null;
  view: 'original' | 'result' | 'compare';
  zoom: 'fit' | 'actual';
  compare: number;
  onCompare: (value: number) => void;
  crop: EditDraft | null;
  onCrop: (crop: {
    cropX: number;
    cropY: number;
    cropW: number;
    cropH: number;
  }) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const dragging = useRef(false);

  useEffect(() => {
    const element = previewRef.current;
    if (!element || zoom === 'actual') return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const ratio = file.width && file.height ? file.width / file.height : 1;
      let width = rect.width;
      let height = width / ratio;
      if (height > rect.height) {
        height = rect.height;
        width = height * ratio;
      }
      setBox({ width: Math.floor(width), height: Math.floor(height) });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [file.width, file.height, zoom]);

  function moveCompare(clientX: number) {
    const element = boxRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    onCompare(clamp(((clientX - rect.left) / rect.width) * 100, 0, 100));
  }

  const showCompare = view !== 'original' && Boolean(result) && !crop;
  const boxStyle =
    zoom === 'fit'
      ? { width: box.width || undefined, height: box.height || undefined }
      : { width: file.width || undefined, height: file.height || undefined };

  return (
    <ScrollArea
      label="图片画布"
      scrollable={zoom === 'actual'}
      className={`preview ${zoom === 'actual' ? 'actual' : ''}`}
      ref={previewRef}
    >
      {!source && <p className="hint">正在读取预览</p>}
      {source && (
        <div className="image-box" ref={boxRef} style={boxStyle}>
          <img src={source} alt={file.name} />
          {result && view !== 'original' && (
            <div
              className="result-layer"
              style={
                view === 'compare'
                  ? { clipPath: `inset(0 0 0 ${compare}%)` }
                  : undefined
              }
            >
              <img src={result.url} alt="处理后" />
            </div>
          )}
          {view === 'compare' && result && (
            <>
              <span className="compare-line" style={{ left: `${compare}%` }} />
              <div
                className="compare-handle"
                style={{ left: `${compare}%` }}
                role="slider"
                tabIndex={0}
                aria-label="对比位置"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(compare)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft')
                    onCompare(clamp(compare - 2, 0, 100));
                  if (event.key === 'ArrowRight')
                    onCompare(clamp(compare + 2, 0, 100));
                }}
              >
                <Icon name="convert" size={20} />
              </div>
              <span className="float-pill left">原图</span>
              <span className="float-pill right">处理后</span>
            </>
          )}
          {crop && <CropOverlay file={file} edit={crop} onChange={onCrop} />}
          {showCompare && (
            <div
              className="compare-surface"
              onPointerDown={(event) => {
                dragging.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                moveCompare(event.clientX);
              }}
              onPointerMove={(event) => {
                if (dragging.current) moveCompare(event.clientX);
              }}
              onPointerUp={(event) => {
                dragging.current = false;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
            />
          )}
        </div>
      )}
    </ScrollArea>
  );
}

function CropOverlay({
  file,
  edit,
  onChange,
}: {
  file: FileRecord;
  edit: EditDraft;
  onChange: (crop: {
    cropX: number;
    cropY: number;
    cropW: number;
    cropH: number;
  }) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    mode: 'move' | 'resize';
    x: number;
    y: number;
    crop: { x: number; y: number; w: number; h: number };
  } | null>(null);
  if (!file.width || !file.height) return null;
  const cropX = edit.useCrop
    ? clamp(edit.cropX, 0, Math.max(file.width - 1, 0))
    : 0;
  const cropY = edit.useCrop
    ? clamp(edit.cropY, 0, Math.max(file.height - 1, 0))
    : 0;
  const crop =
    edit.useCrop && edit.cropW > 0 && edit.cropH > 0
      ? {
          x: cropX,
          y: cropY,
          w: clamp(edit.cropW, 1, Math.max(file.width - cropX, 1)),
          h: clamp(edit.cropH, 1, Math.max(file.height - cropY, 1)),
        }
      : { x: 0, y: 0, w: file.width, h: file.height };
  const left = (crop.x / file.width) * 100;
  const top = (crop.y / file.height) * 100;
  const width = (crop.w / file.width) * 100;
  const height = (crop.h / file.height) * 100;

  function start(mode: 'move' | 'resize', event: ReactPointerEvent) {
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { mode, x: event.clientX, y: event.clientY, crop };
  }

  function move(event: ReactPointerEvent) {
    const state = drag.current;
    const box = boxRef.current?.parentElement;
    if (!state || !box) return;
    const rect = box.getBoundingClientRect();
    const dx = Math.round(
      ((event.clientX - state.x) / rect.width) * file.width,
    );
    const dy = Math.round(
      ((event.clientY - state.y) / rect.height) * file.height,
    );
    if (state.mode === 'move') {
      onChange({
        cropX: clamp(state.crop.x + dx, 0, file.width - state.crop.w),
        cropY: clamp(state.crop.y + dy, 0, file.height - state.crop.h),
        cropW: state.crop.w,
        cropH: state.crop.h,
      });
    } else {
      onChange({
        cropX: state.crop.x,
        cropY: state.crop.y,
        cropW: clamp(state.crop.w + dx, 16, file.width - state.crop.x),
        cropH: clamp(state.crop.h + dy, 16, file.height - state.crop.y),
      });
    }
  }

  return (
    <div
      className="crop-overlay"
      ref={boxRef}
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
      }}
    >
      <div
        className="crop-body"
        onPointerDown={(event) => start('move', event)}
        onPointerMove={move}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
      <span className="crop-line v1" />
      <span className="crop-line v2" />
      <span className="crop-line h1" />
      <span className="crop-line h2" />
      <span
        className="crop-handle nw"
        onPointerDown={(event) => start('resize', event)}
        onPointerMove={move}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
      <span
        className="crop-handle ne"
        onPointerDown={(event) => start('resize', event)}
        onPointerMove={move}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
      <span
        className="crop-handle sw"
        onPointerDown={(event) => start('resize', event)}
        onPointerMove={move}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
      <span
        className="crop-handle se"
        onPointerDown={(event) => start('resize', event)}
        onPointerMove={move}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
      <span className="crop-badge">
        {ratioOf(crop.w, crop.h)} · {crop.w} × {crop.h}
      </span>
    </div>
  );
}

function EvidenceStage({
  file,
  evidence,
  thumb,
}: {
  file: FileRecord;
  evidence: Evidence | null;
  thumb: string;
}) {
  const rows = aigcFields.map((field) => [
    field.name,
    String(evidence?.aigc?.[field.key] ?? ''),
  ]);
  return (
    <div className="evidence-stage">
      <div className="stage-caption">
        <strong>{file.name}</strong>
        <span className="pill soft">
          {evidence?.aigc ? '元数据声明' : '未发现声明'}
        </span>
      </div>
      <div className="evidence-summary">
        <div className="evidence-thumb">
          {thumb ? <img src={thumb} alt="" /> : <span className="thumb" />}
        </div>
        <div>
          <strong>
            {evidence?.aigc ? '已解析 AIGC 声明' : '这份图没有读到 AIGC 声明'}
          </strong>
          {evidence?.aigc && (
            <p>生成属性：{labelText[evidence.aigc.label] ?? '已提供标签'}</p>
          )}
        </div>
      </div>
      <div className="field-table">
        {rows.map(([name, value]) => (
          <p key={name}>
            <span>{name}</span>
            <span>{value || '未提供'}</span>
          </p>
        ))}
        <p>
          <span>内容凭证</span>
          <span>
            C2PA 字节线索
            {evidence?.c2pa.present ? '存在（容器未验证）' : '未发现'} · 签名
            {evidence?.c2pa.signature ?? '未发现'} · 远程核验未验证
          </span>
        </p>
        <p>
          <span>容器字段</span>
          <span>
            ICC {evidence?.icc || '未发现'} · EXIF{' '}
            {evidence?.exifFields ? `${evidence.exifFields} 项` : '未发现'} ·
            XMP {evidence?.hasXmp ? '存在' : '未发现'} · 方向{' '}
            {evidence?.orientation ?? 0}
          </span>
        </p>
      </div>
    </div>
  );
}

function BeforeAfterStage({
  file,
  edit,
  evidence,
}: {
  file: FileRecord;
  edit: EditDraft;
  evidence: Evidence | null;
}) {
  const count = edit.deleteFields.length;
  return (
    <div className="evidence-stage">
      <div className="stage-caption">
        <strong>{file.name}</strong>
        <span className="pill soft">元数据声明</span>
      </div>
      <div className="evidence-block">
        <h3>删除前后对照</h3>
        <p className="hint">选中的 AIGC 声明将从导出副本中移除。</p>
        <div className="field-table">
          <p>
            <span>当前文件 → 导出副本</span>
            <span>AIGC / XMP</span>
          </p>
          <p>
            <span>AIGC 声明</span>
            <span>
              {evidence?.aigc ? `${count} 条字段 · 已移除` : '未发现 · 无改动'}
            </span>
          </p>
          <p>
            <span>作者 / 版权</span>
            <span>保留</span>
          </p>
          <p>
            <span>拍摄信息 / EXIF</span>
            <span>保留</span>
          </p>
          <p>
            <span>色彩配置 / ICC</span>
            <span>保留</span>
          </p>
          <p>
            <span>画面像素</span>
            <span>不变</span>
          </p>
        </div>
      </div>
      <Note tone="warn">
        删除范围：AIGC
        声明及其已识别的重复记录。不会同时清除所有元数据。导出后会重新读取检查。本次为操作预览，源文件尚未修改。
      </Note>
    </div>
  );
}

function StartCompact({
  onImages,
  onFolder,
  onPaste,
}: {
  onImages: () => void;
  onFolder: () => void;
  onPaste: () => void;
}) {
  return (
    <div className="start compact">
      <div className="drop-zone">
        <Icon name="image" size={32} />
        <strong>把图片或文件夹拖到这里</strong>
        <button className="text-button" type="button" onClick={onPaste}>
          也可以粘贴剪贴板中的图片
        </button>
        <div className="choice-row">
          <button className="primary" type="button" onClick={onImages}>
            选择图片
          </button>
          <button className="secondary" type="button" onClick={onFolder}>
            选择文件夹
          </button>
        </div>
      </div>
    </div>
  );
}

function Inspector({
  workspace,
  markPane,
  markAction,
  file,
  edit,
  files,
  evidence,
  aigc,
  readyCount,
  result,
  onEdit,
  onPreview,
  previewing,
  onMarkPane,
  onMarkAction,
  onDeleteField,
  onApplyAll,
  onReset,
  onRemove,
}: {
  workspace: WorkspaceName;
  markPane: MarkPane;
  markAction: MarkAction;
  file: FileRecord | null;
  edit: EditDraft;
  files: FileRecord[];
  evidence: Evidence | null;
  aigc: Evidence['aigc'] | null;
  readyCount: number;
  result: ResultPreview | null;
  onEdit: (edit: EditDraft) => void;
  onPreview: () => void;
  previewing: boolean;
  onMarkPane: (pane: MarkPane) => void;
  onMarkAction: (action: MarkAction) => void;
  onDeleteField: (name: string) => void;
  onApplyAll: () => void;
  onReset: () => void;
  onRemove: () => void;
}) {
  return (
    <ScrollArea as="aside" label="处理设置" className="inspector">
      {workspace === 'compress' && (
        <CompressPanel
          count={readyCount}
          edit={edit}
          result={result}
          onChange={onEdit}
          onPreview={onPreview}
          previewing={previewing}
        />
      )}
      {workspace === 'convert' && (
        <ConvertPanel
          files={files}
          edit={edit}
          onChange={onEdit}
          onPreview={onPreview}
          previewing={previewing}
        />
      )}
      {workspace === 'crop' && (
        <CropPanel
          file={file}
          edit={edit}
          onChange={onEdit}
          onReset={onReset}
          onApplyAll={onApplyAll}
          onPreview={onPreview}
          previewing={previewing}
        />
      )}
      {workspace === 'mark' && (
        <MarkPanel
          pane={markPane}
          file={file}
          action={markAction}
          edit={edit}
          files={files}
          evidence={evidence}
          aigc={aigc}
          onAction={onMarkAction}
          onChange={onEdit}
          onDeleteField={onDeleteField}
          onVisible={() => onMarkPane('visible')}
          onPreview={onPreview}
          previewing={previewing}
        />
      )}
      <div className="inspector-foot">
        <button
          className="text-button"
          type="button"
          onClick={onRemove}
          disabled={!file}
        >
          从列表移除
        </button>
      </div>
    </ScrollArea>
  );
}

function CompressPanel({
  count,
  edit,
  result,
  onChange,
  onPreview,
  previewing,
}: {
  count: number;
  edit: EditDraft;
  result: ResultPreview | null;
  onChange: (edit: EditDraft) => void;
  onPreview: () => void;
  previewing: boolean;
}) {
  const bySize = edit.targetKb > 0;
  return (
    <div className="inspector-panel">
      <h3>压缩设置</h3>
      <p className="panel-sub">批量设置 · 应用于可处理的 {count} 张图片</p>
      <div className="divider" />
      <Segmented
        value={bySize ? 'size' : 'quality'}
        options={[
          { value: 'quality', label: '按画质' },
          { value: 'size', label: '按体积' },
        ]}
        onChange={(value) =>
          onChange({
            ...edit,
            targetKb: value === 'size' ? edit.targetKb || 500 : 0,
          })
        }
      />
      {!bySize ? (
        <>
          <p className="group-label">压缩预设</p>
          <div className="preset-row">
            {[
              ['体积优先', 60],
              ['均衡', 82],
              ['画质优先', 92],
            ].map(([label, quality]) => (
              <button
                key={label}
                className={
                  edit.quality === quality ? 'secondary selected' : 'secondary'
                }
                type="button"
                onClick={() =>
                  onChange({ ...edit, quality: Number(quality), targetKb: 0 })
                }
              >
                {label}
              </button>
            ))}
          </div>
          <SliderField
            label="画质"
            value={edit.quality}
            min={1}
            max={100}
            onChange={(quality) => onChange({ ...edit, quality })}
          />
        </>
      ) : (
        <>
          <Field label="每张不超过">
            <div className="input-suffix">
              <input
                type="number"
                min={1}
                value={edit.targetKb}
                onChange={(event) =>
                  onChange({ ...edit, targetKb: Number(event.target.value) })
                }
              />
              <span>KB</span>
            </div>
          </Field>
          <SliderField
            label="最低画质"
            value={edit.minQuality}
            min={1}
            max={100}
            onChange={(minQuality) =>
              onChange({
                ...edit,
                minQuality: Math.min(minQuality, edit.quality),
              })
            }
          />
          <Check
            label="允许进一步缩小尺寸（未接入）"
            checked={false}
            disabled
            onChange={() => {}}
          />
          {result?.belowTarget && (
            <Note tone="warn">
              当前结果 {formatBytes(result.bytes)}，仍超过目标 {edit.targetKb}{' '}
              KB。可以降低质量下限后重新预览。
            </Note>
          )}
          {result && (
            <button
              className="secondary wide"
              type="button"
              onClick={onPreview}
            >
              调整设置并重试
            </button>
          )}
        </>
      )}
      <div className="divider" />
      <p className="group-label">PNG</p>
      <Check
        label="PNG 转为 8 位调色板（有损，明显变小）"
        checked={edit.pngLossy}
        onChange={(pngLossy) => onChange({ ...edit, pngLossy })}
      />
      <div className="divider" />
      <Field label="尺寸限制">
        <select
          value={edit.scaleMode}
          onChange={(event) =>
            onChange({
              ...edit,
              scaleMode: event.target.value as EditDraft['scaleMode'],
            })
          }
        >
          <option value="keep">保持原始尺寸</option>
          <option value="long">限制长边</option>
          <option value="percent">百分比</option>
        </select>
      </Field>
      {edit.scaleMode === 'long' && (
        <Field label="长边像素">
          <input
            type="number"
            min={1}
            value={edit.longEdge}
            onChange={(event) =>
              onChange({ ...edit, longEdge: Number(event.target.value) })
            }
          />
        </Field>
      )}
      {edit.scaleMode === 'percent' && (
        <Field label="百分比">
          <input
            type="number"
            min={1}
            max={400}
            value={edit.percent}
            onChange={(event) =>
              onChange({ ...edit, percent: Number(event.target.value) })
            }
          />
        </Field>
      )}
      <Check
        label="保留色彩配置（未接入）"
        checked={false}
        disabled
        onChange={() => {}}
      />
      <Check
        label="结果更大时使用原文件"
        checked={edit.keepSmaller}
        onChange={(keepSmaller) => onChange({ ...edit, keepSmaller })}
      />
      <div className="divider" />
      <button
        className="secondary wide"
        type="button"
        disabled={!count || previewing}
        onClick={onPreview}
      >
        {previewing ? '正在生成预览…' : '更新预览'}
      </button>
    </div>
  );
}

function ConvertPanel({
  files,
  edit,
  onChange,
  onPreview,
  previewing,
}: {
  files: FileRecord[];
  edit: EditDraft;
  onChange: (edit: EditDraft) => void;
  onPreview: () => void;
  previewing: boolean;
}) {
  const ready = files.filter((file) => file.status === 'ready' && file.id);
  const alpha = ready.filter((file) => file.hasAlpha).length;
  const animated = ready.find((file) => file.animated || file.pages > 1);
  const toJpeg = edit.outputFormat === 'jpeg';
  return (
    <div className="inspector-panel">
      <h3>转换设置</h3>
      <p className="panel-sub">已选 {ready.length} 张 · 支持不同源格式</p>
      <div className="divider" />
      <Field label="目标格式">
        <select
          value={edit.outputFormat}
          onChange={(event) =>
            onChange({
              ...edit,
              outputFormat: event.target.value as EditDraft['outputFormat'],
            })
          }
        >
          <option value="keep">保持原格式</option>
          <option value="jpeg">JPEG (.jpg)</option>
          <option value="png">PNG</option>
          <option value="webp">WebP（无损）</option>
          <option value="avif">AVIF</option>
        </select>
      </Field>
      {edit.outputFormat !== 'webp' && (
        <SliderField
          label="画质"
          value={edit.quality}
          min={1}
          max={100}
          onChange={(quality) => onChange({ ...edit, quality })}
        />
      )}
      {(edit.outputFormat === 'png' || edit.outputFormat === 'keep') && (
        <>
          <Check
            label="PNG 使用 8 位调色板（有损）"
            checked={edit.pngLossy}
            onChange={(pngLossy) => onChange({ ...edit, pngLossy })}
          />
        </>
      )}
      <div className="divider" />
      <p className="group-label">透明区域</p>
      <Segmented
        value={edit.background.toUpperCase() === '#FFFFFF' ? 'white' : 'custom'}
        options={[
          { value: 'white', label: '白色背景' },
          { value: 'custom', label: '自定义' },
        ]}
        onChange={(value) =>
          onChange({
            ...edit,
            background: value === 'white' ? '#FFFFFF' : '#F7F7F3',
          })
        }
      />
      {edit.background.toUpperCase() !== '#FFFFFF' && (
        <Field label="背景色">
          <input
            value={edit.background}
            onChange={(event) =>
              onChange({ ...edit, background: event.target.value })
            }
          />
        </Field>
      )}
      {toJpeg && alpha > 0 && (
        <Note tone="warn">{alpha} 张图片含透明区域，将填充为背景色。</Note>
      )}
      <div className="divider" />
      <p className="hint">
        ICC 与 EXIF 随 JPEG/PNG 副本自动迁移复检；EXIF 方向烘焙为正向像素。 WebP
        / AVIF 目标不承载这些字段，导出前会请求确认。
      </p>
      <Check
        label="保留原始尺寸"
        checked={edit.scaleMode === 'keep'}
        onChange={(checked) =>
          onChange({ ...edit, scaleMode: checked ? 'keep' : 'long' })
        }
      />
      {animated && (
        <Field label="动画与多页" help="不会静默丢帧或只留首页。">
          <select
            value={edit.keepAnimation ? 'keep' : 'frame'}
            onChange={(event) =>
              onChange({
                ...edit,
                keepAnimation: event.target.value === 'keep',
                frameIndex: event.target.value === 'keep' ? 0 : 1,
              })
            }
          >
            <option value="keep">保留原文件（不改字节）</option>
            <option value="frame">只导出第 1 帧</option>
          </select>
        </Field>
      )}
      <div className="divider" />
      <button
        className="secondary wide"
        type="button"
        disabled={!ready.length || previewing}
        onClick={onPreview}
      >
        {previewing ? '正在生成预览…' : '更新预览'}
      </button>
    </div>
  );
}

function CropPanel({
  file,
  edit,
  onChange,
  onReset,
  onApplyAll,
  onPreview,
  previewing,
}: {
  file: FileRecord | null;
  edit: EditDraft;
  onChange: (edit: EditDraft) => void;
  onReset: () => void;
  onApplyAll: () => void;
  onPreview: () => void;
  previewing: boolean;
}) {
  function ratio(value: number | null) {
    if (!file?.width || !file.height) {
      onChange({ ...edit, useCrop: true });
      return;
    }
    if (value === null) {
      onChange({
        ...edit,
        useCrop: true,
        cropX: 0,
        cropY: 0,
        cropW: file.width,
        cropH: file.height,
      });
      return;
    }
    let width = file.width;
    let height = Math.round(width / value);
    if (height > file.height) {
      height = file.height;
      width = Math.round(height * value);
    }
    onChange({
      ...edit,
      useCrop: true,
      cropX: Math.round((file.width - width) / 2),
      cropY: Math.round((file.height - height) / 2),
      cropW: width,
      cropH: height,
    });
  }
  const width = edit.useCrop && edit.cropW ? edit.cropW : (file?.width ?? 0);
  const height = edit.useCrop && edit.cropH ? edit.cropH : (file?.height ?? 0);
  return (
    <div className="inspector-panel">
      <h3>裁剪设置</h3>
      <p className="panel-sub">当前图片 · {file?.name ?? '还没有选择'}</p>
      <div className="divider" />
      <p className="group-label">裁剪比例</p>
      <Segmented
        value={ratioOf(width, height)}
        options={[
          { value: '自由', label: '自由' },
          { value: '1 : 1', label: '1 : 1' },
          { value: '3 : 2', label: '3 : 2' },
          { value: '16 : 9', label: '16 : 9' },
        ]}
        onChange={(value) =>
          ratio(
            value === '自由'
              ? null
              : value === '1 : 1'
                ? 1
                : value === '3 : 2'
                  ? 1.5
                  : 16 / 9,
          )
        }
      />
      <Field label="裁剪区域">
        <div className="pair">
          <label className="inline-input">
            <span>宽</span>
            <input
              type="number"
              min={16}
              max={file?.width ?? undefined}
              value={width || ''}
              onChange={(event) =>
                onChange({
                  ...edit,
                  useCrop: true,
                  cropW: clamp(
                    Number(event.target.value),
                    16,
                    file?.width ?? 16,
                  ),
                })
              }
            />
          </label>
          <label className="inline-input">
            <span>高</span>
            <input
              type="number"
              min={16}
              max={file?.height ?? undefined}
              value={height || ''}
              onChange={(event) =>
                onChange({
                  ...edit,
                  useCrop: true,
                  cropH: clamp(
                    Number(event.target.value),
                    16,
                    file?.height ?? 16,
                  ),
                })
              }
            />
          </label>
        </div>
      </Field>
      <Field label="输出尺寸">
        <p className="readout">
          宽 {width || '—'} × 高 {height || '—'} px
        </p>
      </Field>
      <Check
        label="不放大图片"
        checked={!edit.allowUpscale}
        onChange={(checked) => onChange({ ...edit, allowUpscale: !checked })}
      />
      <div className="divider" />
      <div className="segmented actions">
        <button
          type="button"
          onClick={() =>
            onChange({
              ...edit,
              rotation: ((edit.rotation + 270) % 360) as EditDraft['rotation'],
            })
          }
        >
          左转 90°
        </button>
        <button
          type="button"
          onClick={() =>
            onChange({
              ...edit,
              rotation: ((edit.rotation + 90) % 360) as EditDraft['rotation'],
            })
          }
        >
          右转 90°
        </button>
        <button
          type="button"
          aria-pressed={edit.flipH}
          onClick={() => onChange({ ...edit, flipH: !edit.flipH })}
        >
          翻转
        </button>
      </div>
      <SliderField
        label="拉直"
        value={edit.straighten}
        min={-45}
        max={45}
        suffix="°"
        onChange={(straighten) => onChange({ ...edit, straighten })}
      />
      <div className="two-actions">
        <button className="secondary" type="button" onClick={onReset}>
          重置
        </button>
        <button className="secondary" type="button" onClick={onApplyAll}>
          应用全部
        </button>
      </div>
      <button
        className="secondary wide"
        type="button"
        disabled={!file || previewing}
        onClick={onPreview}
      >
        {previewing ? '正在生成预览…' : '更新预览'}
      </button>
    </div>
  );
}

function MarkPanel({
  pane,
  file,
  action,
  edit,
  files,
  evidence,
  aigc,
  onAction,
  onChange,
  onDeleteField,
  onVisible,
  onPreview,
  previewing,
}: {
  pane: MarkPane;
  file: FileRecord | null;
  action: MarkAction;
  edit: EditDraft;
  files: FileRecord[];
  evidence: Evidence | null;
  aigc: Evidence['aigc'] | null;
  onAction: (action: MarkAction) => void;
  onChange: (edit: EditDraft) => void;
  onDeleteField: (name: string) => void;
  onVisible: () => void;
  onPreview: () => void;
  previewing: boolean;
}) {
  if (pane === 'visible') {
    const template =
      watermarkTemplates.find((item) => item.text === edit.watermarkText)
        ?.label ?? '自定义';
    return (
      <div className="inspector-panel">
        <h3>添加明水印</h3>
        <p className="panel-sub">当前图片 · 只写入导出副本</p>
        <div className="divider" />
        <Segmented
          value={edit.watermarkImageId ? 'image' : 'text'}
          options={[
            { value: 'text', label: '文字' },
            { value: 'image', label: '图片' },
          ]}
          onChange={(value) =>
            onChange({
              ...edit,
              watermark: true,
              watermarkImageId: value === 'text' ? '' : edit.watermarkImageId,
              watermarkText: value === 'text' ? edit.watermarkText : '',
            })
          }
        />
        <Field label="用途模板">
          <select
            value={template}
            onChange={(event) => {
              const next = watermarkTemplates.find(
                (item) => item.label === event.target.value,
              );
              if (!next || next.label === '自定义') return;
              onChange({
                ...edit,
                watermark: true,
                watermarkText: next.text,
                watermarkMode: next.mode,
                opacity: next.opacity,
              });
            }}
          >
            {watermarkTemplates.map((item) => (
              <option key={item.label} value={item.label}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        {edit.watermarkImageId === '' ? (
          <Field label="水印内容">
            <input
              value={edit.watermarkText}
              onChange={(event) =>
                onChange({
                  ...edit,
                  watermark: true,
                  watermarkText: event.target.value,
                })
              }
            />
          </Field>
        ) : (
          <Field label="水印图片" help="只使用已导入且可处理的静态图片。">
            <select
              value={edit.watermarkImageId}
              onChange={(event) =>
                onChange({
                  ...edit,
                  watermark: true,
                  watermarkImageId: event.target.value,
                })
              }
            >
              <option value="">不使用图片</option>
              {files
                .filter(
                  (file) =>
                    file.status === 'ready' &&
                    file.id &&
                    !file.animated &&
                    file.pages <= 1,
                )
                .map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="标注方式">
          <select
            value={edit.watermarkMode}
            onChange={(event) =>
              onChange({
                ...edit,
                watermark: true,
                watermarkMode: event.target.value as EditDraft['watermarkMode'],
              })
            }
          >
            <option value="tile">斜向平铺</option>
            <option value="single">单处</option>
            <option value="center">居中</option>
          </select>
        </Field>
        {edit.watermarkMode === 'single' && (
          <Field label="位置">
            <select
              value={edit.anchor}
              onChange={(event) =>
                onChange({
                  ...edit,
                  watermark: true,
                  anchor: event.target.value,
                })
              }
            >
              {anchors.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <SliderField
          label="不透明度"
          value={edit.opacity}
          min={0}
          max={100}
          onChange={(opacity) =>
            onChange({ ...edit, watermark: true, opacity })
          }
        />
        <Field label="文字与间距">
          <div className="triple">
            <label className="inline-input">
              <input
                type="number"
                min={8}
                max={256}
                value={edit.fontSize}
                onChange={(event) =>
                  onChange({
                    ...edit,
                    watermark: true,
                    fontSize: Number(event.target.value),
                  })
                }
              />
              <span>px</span>
            </label>
            <label className="inline-input">
              <input
                type="number"
                min={-180}
                max={180}
                value={edit.angle}
                onChange={(event) =>
                  onChange({
                    ...edit,
                    watermark: true,
                    angle: Number(event.target.value),
                  })
                }
              />
              <span>°</span>
            </label>
            <label className="inline-input">
              <input
                type="number"
                min={8}
                value={edit.gap}
                onChange={(event) =>
                  onChange({
                    ...edit,
                    watermark: true,
                    gap: Number(event.target.value),
                  })
                }
              />
              <span>间距</span>
            </label>
          </div>
        </Field>
        <Check
          label="附加日期（未接入）"
          checked={false}
          disabled
          onChange={() => {}}
        />
        <Check
          label="同步写入元数据说明（未接入）"
          checked={false}
          disabled
          onChange={() => {}}
        />
        <Note>
          用途水印会直接画进导出图片。请检查用途文字是否准确，以及关键信息是否仍可辨认。
        </Note>
        <button
          className="secondary wide"
          type="button"
          disabled
          onClick={() => {}}
        >
          保存为用途模板（未接入）
        </button>
        <button
          className="secondary wide"
          type="button"
          disabled={previewing}
          onClick={onPreview}
        >
          {previewing ? '正在生成预览…' : '更新预览'}
        </button>
      </div>
    );
  }

  const fields = aigc
    ? aigcFields.filter((field) => String(aigc[field.key] ?? ''))
    : [];
  return (
    <div className="inspector-panel">
      <h3>
        {action === 'remove'
          ? '删除元数据声明'
          : action === 'rewrite'
            ? '补充 / 改写'
            : '声明检测'}
      </h3>
      <div className="divider" />
      <Segmented
        value={action}
        options={[
          { value: 'read', label: '检测' },
          { value: 'remove', label: '删除' },
          { value: 'rewrite', label: '补充 / 改写' },
        ]}
        onChange={(value) => onAction(value as MarkAction)}
      />
      {action === 'read' && (
        <>
          <EvidenceCard
            title="元数据声明"
            tone={aigc ? 'found' : 'plain'}
            lines={
              aigc
                ? [
                    `AIGC / Label = ${aigc.label}`,
                    `声明：${labelText[aigc.label] ?? '已提供标签'}`,
                    `ContentProducer：${aigc.contentProducer || '未提供'}`,
                  ]
                : [file ? '未发现 AIGC 声明' : '待添加图片']
            }
          />
          <EvidenceCard title="明水印" tone="warn" lines={['自动识别未安装']} />
          {evidence?.auxiliary?.length ? (
            <EvidenceCard
              title="辅助来源信息"
              tone="plain"
              lines={evidence.auxiliary}
            />
          ) : null}
          <div className="divider" />
          <button
            className="secondary wide"
            type="button"
            onClick={() => onAction('remove')}
            disabled={!aigc}
          >
            删除元数据声明
          </button>
          <button
            className="secondary wide"
            type="button"
            onClick={() => onAction('rewrite')}
          >
            补充 / 改写声明
          </button>
          <button className="text-button" type="button" onClick={onVisible}>
            查看明水印
          </button>
        </>
      )}
      {action === 'remove' && (
        <>
          <p className="group-label">已发现的声明字段</p>
          {fields.length > 0 ? (
            <div className="check-list">
              {fields.map((field) => (
                <Check
                  key={field.name}
                  label={`${field.name} · ${String(aigc?.[field.key] ?? '')}`}
                  checked={edit.deleteFields.includes(field.name)}
                  onChange={() => onDeleteField(field.name)}
                />
              ))}
            </div>
          ) : (
            <p className="hint">
              这份文件没有读到可删除的 AIGC 声明。未发现项不会被说成“已清除”。
            </p>
          )}
          <Note tone="warn">
            元数据声明与明水印分别处理。本次不会删除画面中的文字，也不会同时清除所有元数据。
          </Note>
          <button
            className="secondary wide"
            type="button"
            onClick={() => onAction('read')}
          >
            返回编辑声明
          </button>
          <button
            className="secondary wide"
            type="button"
            disabled={!fields.length || previewing}
            onClick={onPreview}
          >
            {previewing ? '正在生成预览…' : '更新预览'}
          </button>
        </>
      )}
      {action === 'rewrite' && (
        <>
          <Field label="声明方式">
            <select
              value={edit.metadataPolicy}
              onChange={(event) =>
                onChange({
                  ...edit,
                  metadataPolicy: event.target
                    .value as EditDraft['metadataPolicy'],
                })
              }
            >
              <option value="addAigc">补充 AIGC 声明（只补缺失项）</option>
              <option value="replaceAigc">替换已有 AIGC 声明</option>
              <option value="addGeneric">追加通用用户声明</option>
            </select>
          </Field>
          {edit.metadataPolicy === 'addGeneric' ? (
            <>
              <Field label="作者">
                <input
                  value={edit.author}
                  onChange={(event) =>
                    onChange({ ...edit, author: event.target.value })
                  }
                />
              </Field>
              <Field label="版权">
                <input
                  value={edit.copyright}
                  onChange={(event) =>
                    onChange({ ...edit, copyright: event.target.value })
                  }
                />
              </Field>
              <Field label="说明">
                <input
                  value={edit.description}
                  onChange={(event) =>
                    onChange({ ...edit, description: event.target.value })
                  }
                />
              </Field>
              <p className="hint">通用声明至少需要作者、版权或说明中的一项。</p>
            </>
          ) : (
            <>
              <Field label="来源平台">
                <select
                  value={
                    edit.producer.trim() === ''
                      ? ''
                      : AIGC_PRODUCERS.includes(edit.producer.trim())
                        ? edit.producer.trim()
                        : '__custom__'
                  }
                  onChange={(event) =>
                    onChange({
                      ...edit,
                      producer:
                        event.target.value === '__custom__'
                          ? ''
                          : event.target.value,
                    })
                  }
                >
                  <option value="">纯钧（本地声明）</option>
                  {AIGC_PRODUCERS.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  <option value="__custom__">自定义…</option>
                </select>
              </Field>
              <Field label="声明主体">
                <input
                  value={edit.producer}
                  placeholder="纯钧"
                  onChange={(event) =>
                    onChange({ ...edit, producer: event.target.value })
                  }
                />
              </Field>
              <Field label="生成属性">
                <select
                  value={edit.aigcLabel}
                  onChange={(event) =>
                    onChange({
                      ...edit,
                      aigcLabel: event.target.value as EditDraft['aigcLabel'],
                    })
                  }
                >
                  <option value="1">1 · 属于 AI 生成合成</option>
                  <option value="2">2 · 可能为 AI 生成合成</option>
                  <option value="3">3 · 疑似为 AI 生成合成</option>
                </select>
              </Field>
            </>
          )}
          <div className="divider" />
          <button
            className="secondary wide"
            type="button"
            onClick={() => onAction('read')}
          >
            返回编辑声明
          </button>
          <button className="secondary wide" type="button" onClick={onPreview}>
            更新预览
          </button>
        </>
      )}
    </div>
  );
}

function EvidenceCard({
  title,
  lines,
  tone,
}: {
  title: string;
  lines: string[];
  tone: 'found' | 'warn' | 'plain';
}) {
  return (
    <article className={`scan-card ${tone}`}>
      <strong>{title}</strong>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </article>
  );
}

function SettingsPage({
  settings,
  onChange,
  edit,
  onEdit,
  outputLabel,
  onOutput,
  saveState,
  available,
  onBack,
  onClearHistory,
  onSaveDraft,
  onRestoreDraft,
  onClearPreview,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  edit: EditDraft;
  onEdit: (edit: EditDraft) => void;
  outputLabel: string;
  onOutput: () => void;
  saveState: 'pending' | 'saving' | 'saved' | 'failed';
  available: boolean;
  onBack: () => void;
  onClearHistory: () => void;
  onSaveDraft: () => void;
  onRestoreDraft: () => void;
  onClearPreview: () => void;
}) {
  return (
    <section className="page">
      <ScrollArea label="设置" className="settings-layout">
        <div className="settings-card">
          <h3>默认导出偏好</h3>
          <div className="field">
            <span>保存位置（本次会话）</span>
            <button
              className="secondary wide path-button"
              type="button"
              onClick={onOutput}
            >
              {outputLabel}
            </button>
          </div>
          <ExportNamingFields
            value={edit}
            onChange={(patch) => onEdit({ ...edit, ...patch })}
          />
          <div className="divider" />
          <h3>本地数据</h3>
          <div className="cache-row">
            <span>预览缓存</span>
            <button
              className="secondary"
              type="button"
              onClick={onClearPreview}
            >
              清理缓存
            </button>
          </div>
          <Check
            label="保留本机处理记录"
            checked={settings.historyEnabled}
            onChange={(historyEnabled) =>
              onChange({ ...settings, historyEnabled })
            }
          />
          <button
            className="text-button"
            type="button"
            onClick={onClearHistory}
          >
            清除处理记录
          </button>
          <div className="divider" />
          <h3>工作区草稿</h3>
          <div className="cache-row">
            <span>当前图片与参数</span>
            <button
              className="secondary"
              type="button"
              onClick={onSaveDraft}
              disabled={!available}
            >
              保存草稿
            </button>
          </div>
          <div className="cache-row">
            <span>上次保存的草稿</span>
            <button
              className="secondary"
              type="button"
              onClick={onRestoreDraft}
              disabled={!available}
            >
              恢复草稿
            </button>
          </div>
          <div className="divider" />
          <h3>性能</h3>
          <Field label="同时处理数量">
            <select
              value={settings.concurrency}
              onChange={(event) =>
                onChange({
                  ...settings,
                  concurrency: Number(event.target.value),
                })
              }
            >
              <option value={1}>1 张</option>
              <option value={2}>2 张</option>
            </select>
          </Field>
          <Check
            label="文件夹导入包含子目录"
            checked={settings.recursiveFolders}
            onChange={(recursiveFolders) =>
              onChange({ ...settings, recursiveFolders })
            }
          />
        </div>
      </ScrollArea>
      <ActionBar
        summary={available ? '设置自动保存在本机' : '浏览器预览，设置不会保存'}
        sub={`保存到：${outputLabel}。源文件保持只读。`}
        note={
          !available
            ? { text: '请在桌面窗口保存设置', tone: 'info' }
            : saveState === 'failed'
              ? { text: '保存失败，请重试', tone: 'warn' }
              : saveState === 'saved'
                ? { text: '已自动保存', tone: 'info' }
                : { text: '正在保存…', tone: 'info' }
        }
        primary="返回工作区"
        onPrimary={onBack}
      />
    </section>
  );
}

function HistoryPage({
  report,
  history,
  historyEnabled,
  onOpen,
  onRetry,
  onAdd,
  onBack,
  onOutput,
  onPreview,
  onThumb,
  onCopy,
  onReveal,
}: {
  report: ExportReport | null;
  history: HistoryItem[];
  historyEnabled: boolean;
  onOpen: (id: string) => void;
  onRetry: () => void;
  onAdd: () => void;
  onBack: () => void;
  onOutput: () => void;
  onPreview: (jobId: string, fileId: string) => Promise<PreviewImage>;
  onThumb: (jobId: string, fileId: string) => Promise<string>;
  onCopy: (jobId: string, fileId: string) => Promise<void>;
  onReveal: (jobId: string, fileId: string) => Promise<void>;
}) {
  const [preview, setPreview] = useState<{
    item: ExportItem;
    image: PreviewImage;
  } | null>(null);
  const [busy, setBusy] = useState('');
  const [tip, setTip] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbLoader = useRef(onThumb);
  useEffect(() => {
    thumbLoader.current = onThumb;
  }, [onThumb]);

  useEffect(() => {
    if (!report) return;
    let cancelled = false;
    for (const item of report.items) {
      if (item.outputPath === '') continue;
      if (item.state !== 'success' && item.state !== 'below_target') continue;
      const key = `${report.jobId}:${item.id}`;
      void thumbLoader
        .current(report.jobId, item.id)
        .then((data) => {
          if (!cancelled && data)
            setThumbs((current) => ({ ...current, [key]: data }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [report]);

  function previewItem(item: ExportItem) {
    if (!report) return;
    setBusy(item.id);
    setTip('');
    onPreview(report.jobId, item.id)
      .then((image) => setPreview({ item, image }))
      .catch((reason: Error) => setTip(reason.message))
      .finally(() => setBusy(''));
  }

  function copyItem(item: ExportItem) {
    if (!report) return;
    setBusy(item.id);
    setTip('');
    onCopy(report.jobId, item.id)
      .then(() => setTip(`已复制 ${item.outputName} 到剪贴板`))
      .catch((reason: Error) => setTip(reason.message))
      .finally(() => setBusy(''));
  }

  function revealItem(item: ExportItem) {
    if (!report) return;
    setTip('');
    onReveal(report.jobId, item.id).catch((reason: Error) =>
      setTip(reason.message),
    );
  }

  const failed = report?.items.filter((item) => item.state === 'failed') ?? [];
  const below =
    report?.items.filter((item) => item.state === 'below_target') ?? [];
  const retryable = report ? failed.length + below.length : 0;
  const savedBytes = report?.savedBytes ?? 0;
  const summary = report
    ? `已导出 ${report.success} 张${retryable ? `，${retryable} 张需要重试` : '，全部完成'}${report.cancelled ? `，${report.cancelled} 项因取消未执行` : ''}`
    : '本机处理记录';
  return (
    <section className="page">
      <ScrollArea label="处理记录" className="history-page">
        {report ? (
          <>
            <div className="summary-card">
              <div>
                <h3>{summary}</h3>
                <p>
                  已减少 {formatBytes(Math.max(savedBytes, 0))} · 保存到{' '}
                  {report.outputLabel}
                </p>
              </div>
              <div className="summary-actions">
                <button
                  className="primary"
                  type="button"
                  onClick={() => onOpen(report.jobId)}
                >
                  打开文件夹
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={onRetry}
                  disabled={retryable === 0}
                >
                  重试失败项
                </button>
              </div>
            </div>
            <div className="result-table">
              <div className="table-head">
                <span>文件</span>
                <span>结果</span>
                <span>状态</span>
                <span>操作</span>
              </div>
              {report.items.map((item) => (
                <div
                  className="table-row"
                  key={`${item.id}-${item.outputName}`}
                >
                  <span className="file-cell">
                    {thumbs[`${report.jobId}:${item.id}`] ? (
                      <img
                        className="result-thumb"
                        src={`data:image/png;base64,${thumbs[`${report.jobId}:${item.id}`]}`}
                        alt={`${item.name} 缩略图`}
                        onClick={() => previewItem(item)}
                      />
                    ) : (
                      <span className="result-thumb placeholder" aria-hidden />
                    )}
                    <span className="done-name">{item.name}</span>
                  </span>
                  <span>
                    {item.state === 'failed'
                      ? item.message
                      : item.state === 'skipped'
                        ? item.message
                        : `${formatBytes(item.sourceBytes)} → ${formatBytes(item.bytes)}`}
                  </span>
                  <span>
                    <Badge
                      tone={
                        item.state === 'success'
                          ? 'soft'
                          : item.state === 'below_target'
                            ? 'warn'
                            : 'error'
                      }
                    >
                      {item.state === 'success'
                        ? '已完成'
                        : item.state === 'below_target'
                          ? '未达标'
                          : item.state === 'skipped'
                            ? '已跳过'
                            : '需要重试'}
                    </Badge>
                  </span>
                  <span className="row-actions">
                    <button
                      className="icon-button"
                      type="button"
                      title="预览"
                      aria-label={`预览 ${item.name}`}
                      disabled={
                        busy === item.id ||
                        (item.state !== 'success' &&
                          item.state !== 'below_target')
                      }
                      onClick={() => previewItem(item)}
                    >
                      <Icon name="eye" size={18} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title="复制图片"
                      aria-label={`复制 ${item.name}`}
                      disabled={
                        busy === item.id ||
                        (item.state !== 'success' &&
                          item.state !== 'below_target')
                      }
                      onClick={() => copyItem(item)}
                    >
                      <Icon name="copy" size={18} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title="打开所在文件夹"
                      aria-label={`打开 ${item.name} 所在文件夹`}
                      disabled={item.outputPath === '' || busy === item.id}
                      onClick={() => revealItem(item)}
                    >
                      <Icon name="folder-open" size={18} />
                    </button>
                  </span>
                </div>
              ))}
              {tip && <p className="table-note">{tip}</p>}
              {retryable > 0 && (
                <p className="table-note">
                  失败项：
                  {report.items
                    .filter((item) => item.state !== 'success')
                    .map((item) => item.name)
                    .join('、')}{' '}
                  · 重新选择源文件后可继续。
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="result-table empty">
            <h3>还没有本次结果</h3>
          </div>
        )}
        {!report && !historyEnabled && (
          <div className="result-table empty">
            <h3>本机记录已关闭</h3>
            <p>
              不再保存新的处理记录；已保存的记录仍保留在设置里，重新打开开关即可恢复。
            </p>
          </div>
        )}
        {!report && historyEnabled && history.length > 0 && (
          <div className="result-table">
            <h3>本机历史</h3>
            {history.map((item) => (
              <div className="history-row" key={item.id}>
                <div>
                  <strong>{item.label}</strong>
                  <p>
                    成功 {item.success} · 未达标 {item.belowTarget} · 失败{' '}
                    {item.failed}
                  </p>
                </div>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => onOpen(item.id)}
                >
                  打开文件夹
                </button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
      {preview && (
        <div
          className="preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`${preview.item.name} 预览`}
        >
          <div className="preview-modal-body">
            <header>
              <div>
                <h3>{preview.item.outputName}</h3>
                <p className="hint">
                  {preview.image.width} × {preview.image.height} ·{' '}
                  {formatBytes(preview.item.bytes)}
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭预览"
                onClick={() => setPreview(null)}
              >
                <Icon name="close" size={20} />
              </button>
            </header>
            <ScrollArea label="结果预览" className="preview-modal-image">
              <img
                src={`data:image/png;base64,${preview.image.pngBase64}`}
                alt={preview.item.name}
              />
            </ScrollArea>
            <footer>
              <span className="hint">
                保存到 {preview.item.outputPath || '导出目录'}
              </span>
              <button
                className="secondary"
                type="button"
                onClick={() => copyItem(preview.item)}
              >
                复制图片
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => revealItem(preview.item)}
              >
                打开所在文件夹
              </button>
            </footer>
          </div>
        </div>
      )}
      <ActionBar
        summary={
          report
            ? `已完成 ${report.success} 张 · 失败 ${report.failed} 张 · 已导出副本不受影响`
            : '没有待处理的导出结果'
        }
        sub={`保存到：${report?.outputLabel ?? '原目录 / 纯钧导出'}。源文件保持只读。`}
        secondary="更改保存位置"
        onSecondary={onOutput}
        primary="继续添加图片"
        onPrimary={onAdd}
        extra={
          <button className="text-button" type="button" onClick={onBack}>
            返回工作区
          </button>
        }
      />
    </section>
  );
}

function ProgressPage({
  progress,
  items,
  paused,
  notice,
  outputLabel,
  canControl,
  onPause,
  onResume,
  onCancel,
  onHistory,
  onOutput,
}: {
  progress: {
    done: number;
    total: number;
    name: string;
    stage: string;
    fraction: number;
  };
  items: ExportItem[];
  paused: boolean;
  notice: Notice;
  outputLabel: string;
  canControl: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onHistory: () => void;
  onOutput: () => void;
}) {
  const total = Math.max(progress.total, 1);
  const counted = Math.round((Math.min(progress.done, total) / total) * 100);
  const percent =
    progress.fraction > 0
      ? Math.min(100, Math.max(0, Math.round(progress.fraction * 100)))
      : counted;
  return (
    <section className="page">
      <ScrollArea label="处理进度" className="progress-page">
        <article className="progress-card">
          <Badge tone="soft">正在导出</Badge>
          <h3>
            正在处理第 {Math.min(progress.done + 1, total)} /{' '}
            {progress.total || 1} 张
          </h3>
          <p className="progress-file">
            {progress.name || '准备中'}
            {progress.stage ? ` · ${progress.stage}` : ''}
          </p>
          <div className="bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="progress-values">
            <strong>{percent}%</strong>
            <span>已完成 {Math.min(progress.done, progress.total)} 张</span>
          </div>
          <div className="divider" />
          <h4>已完成</h4>
          {items.length === 0 && <p className="hint">还没有完成的文件。</p>}
          {items.map((item) => (
            <p
              className={`done-row ${item.state === 'failed' ? 'is-failed' : ''}`}
              key={`${item.id}-${item.outputName}`}
            >
              <Icon
                name={item.state === 'failed' ? 'warning' : 'check'}
                size={20}
              />
              <span className="done-name">{item.name}</span>
              <span className="done-state">
                {item.state === 'success'
                  ? `${formatBytes(item.sourceBytes)} → ${formatBytes(item.bytes)}`
                  : item.state === 'below_target'
                    ? '未达标'
                    : item.state === 'skipped'
                      ? '已跳过'
                      : item.message}
              </span>
            </p>
          ))}
          <div className="choice-row">
            {paused ? (
              <button
                className="secondary"
                type="button"
                disabled={!canControl}
                onClick={onResume}
              >
                继续处理
              </button>
            ) : (
              <button
                className="secondary"
                type="button"
                disabled={!canControl}
                onClick={onPause}
              >
                暂停处理
              </button>
            )}
            <button
              className="text-button"
              type="button"
              disabled={!canControl}
              onClick={onCancel}
            >
              取消剩余项
            </button>
          </div>
        </article>
        <p className="progress-hint">
          {paused
            ? '已暂停：当前文件完成后停住。'
            : '暂停将在当前文件完成后生效。取消会保留已经完成的副本。'}
        </p>
        {notice.tone === 'warn' && (
          <p className="progress-hint warn">{notice.text}</p>
        )}
      </ScrollArea>
      <ActionBar
        summary={`导出中 · ${Math.min(progress.done, progress.total)} / ${progress.total || 1} 张完成`}
        sub={`保存到：${outputLabel}。源文件保持只读。`}
        secondary="更改保存位置"
        onSecondary={onOutput}
        primary="查看处理记录"
        onPrimary={onHistory}
      />
    </section>
  );
}

function ActionBar({
  summary,
  sub,
  notice,
  note,
  secondary,
  onSecondary,
  primary,
  onPrimary,
  primaryDisabled = false,
  onViewHistory,
  extra,
  location,
  secondaryExpanded,
  secondaryControls,
}: {
  summary: string;
  sub: string;
  notice?: Notice;
  note?: Notice;
  secondary?: string;
  onSecondary?: () => void;
  primary: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  onViewHistory?: () => void;
  extra?: ReactNode;
  location?: { label: string; onClick: () => void };
  secondaryExpanded?: boolean;
  secondaryControls?: string;
}) {
  return (
    <footer className="action-bar">
      <Icon name="folder" size={20} />
      <p className="action-summary">
        <strong>{summary}</strong>
        {location ? (
          <button
            className="output-location"
            type="button"
            onClick={location.onClick}
            title={`保存到：${location.label}`}
          >
            保存到：{location.label}
          </button>
        ) : (
          <span>{sub}</span>
        )}
      </p>
      {notice?.tone === 'warn' && (
        <span className="action-note">{notice.text}</span>
      )}
      {note && <span className={`action-note ${note.tone}`}>{note.text}</span>}
      {extra}
      {onViewHistory && (
        <button className="text-button" type="button" onClick={onViewHistory}>
          查看处理记录
        </button>
      )}
      {secondary && (
        <button
          className="secondary"
          type="button"
          onClick={onSecondary}
          aria-expanded={secondaryExpanded}
          aria-controls={secondaryControls}
        >
          {secondary}
        </button>
      )}
      <button
        className="primary"
        type="button"
        disabled={primaryDisabled}
        onClick={onPrimary}
      >
        {primary}
      </button>
    </footer>
  );
}

function Segmented({
  value,
  options,
  onChange,
  className = '',
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`segmented ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {help && <small className="hint">{help}</small>}
    </label>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  suffix = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider-field">
      <span>{label}</span>
      <strong>
        {value}
        {suffix}
      </strong>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Check({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label className={`check ${disabled ? 'is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function Note({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn';
  children: ReactNode;
}) {
  return (
    <div className={`note ${tone}`}>
      <Icon name={tone === 'warn' ? 'warning' : 'shield'} size={16} />
      <p>{children}</p>
    </div>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: 'soft' | 'warn' | 'error';
  children: ReactNode;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
