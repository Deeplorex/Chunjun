import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import type { DesktopClient } from './platform/types';

function client(partial: Partial<DesktopClient> = {}): DesktopClient {
  return {
    available: true,
    status: vi.fn().mockResolvedValue('ready'),
    pickImages: vi.fn().mockResolvedValue([]),
    pickFolder: vi.fn().mockResolvedValue([]),
    importPaths: vi.fn().mockResolvedValue([]),
    importClipboard: vi.fn().mockResolvedValue([]),
    removeFiles: vi.fn().mockResolvedValue(undefined),
    pickOutput: vi.fn().mockResolvedValue(null),
    currentOutput: vi.fn().mockResolvedValue(null),
    clearOutput: vi.fn().mockResolvedValue(undefined),
    filePreview: vi
      .fn()
      .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
    fileEvidence: vi.fn().mockResolvedValue({
      aigc: null,
      auxiliary: [],
      c2pa: {
        present: false,
        signature: '未发现',
        trust: '未发现',
        remote: '未验证',
      },
      icc: '',
      orientation: 1,
      copyright: '',
      notes: [],
      exifFields: 0,
      hasXmp: false,
      hasTextChunks: false,
      hasColorChunks: false,
    }),
    previewExport: vi.fn().mockResolvedValue({
      pngBase64: '',
      width: 100,
      height: 100,
      encodedBytes: 1000,
      belowTarget: false,
      message: '',
    }),
    startExport: vi.fn(),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(),
    cancelJob: vi.fn(),
    openOutput: vi.fn(),
    exportPreview: vi.fn().mockResolvedValue({
      pngBase64: '',
      width: 100,
      height: 100,
    }),
    exportThumb: vi.fn().mockResolvedValue(''),
    exportReveal: vi.fn().mockResolvedValue(undefined),
    exportCopy: vi.fn().mockResolvedValue(undefined),
    loadSettings: vi.fn().mockResolvedValue({
      concurrency: 1,
      historyEnabled: true,
      recursiveFolders: false,
      conflict: 'number',
      prefix: '',
      suffix: '',
    }),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    listHistory: vi.fn().mockResolvedValue([]),
    clearHistory: vi.fn(),
    saveDraft: vi.fn(),
    loadDraft: vi.fn().mockResolvedValue({ files: [], document: '' }),
    ...partial,
  };
}

describe('desktop workspace', () => {
  it('confirms transparency loss, traps focus and cancels with Escape', async () => {
    const startExport = vi.fn();
    render(
      <App
        client={client({
          pickImages: vi
            .fn()
            .mockResolvedValue([
              { ...sampleFile, format: 'png', hasAlpha: true },
            ]),
          startExport,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    fireEvent.click(screen.getByRole('button', { name: '导出设置' }));
    fireEvent.change(screen.getByLabelText('输出格式'), {
      target: { value: 'jpeg' },
    });
    const trigger = screen.getByRole('button', { name: '导出 1 张图片' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('JPEG 不支持透明');
    const cancel = screen.getByRole('button', { name: '返回调整' });
    const confirm = screen.getByRole('button', { name: '确认并导出' });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    expect(startExport).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.getByRole('heading', { name: '图片压缩' })).toBeVisible();
  });

  it('requires explicit confirmation before extracting a frame and exports only once', async () => {
    const startExport = vi.fn().mockImplementation(() => new Promise(() => {}));
    render(
      <App
        client={client({
          pickImages: vi
            .fn()
            .mockResolvedValue([
              { ...sampleFile, animated: true, pages: 4, format: 'gif' },
            ]),
          startExport,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      '只导出第 1 帧',
    );
    expect(startExport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认并导出' }));
    await waitFor(() => expect(startExport).toHaveBeenCalledOnce());
    expect(startExport).toHaveBeenCalledWith(
      [
        {
          id: 'f1',
          edit: expect.objectContaining({
            frameIndex: 1,
            keepAnimation: false,
          }),
        },
      ],
      true,
      expect.any(Function),
    );
    expect(
      await screen.findByRole('heading', { name: '正在处理' }),
    ).toBeVisible();
  });

  it('migrates source metadata for capable targets without asking', async () => {
    const startExport = vi.fn().mockImplementation(() => new Promise(() => {}));
    const service = client({
      pickImages: vi.fn().mockResolvedValue([sampleFile]),
      startExport,
    });
    const evidence = await service.fileEvidence('f1');
    service.fileEvidence = vi.fn().mockResolvedValue({
      ...evidence,
      icc: '存在',
      exifFields: 12,
      orientation: 6,
    });
    render(<App client={service} />);
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
    await waitFor(() =>
      expect(startExport).toHaveBeenCalledWith(
        [
          {
            id: 'f1',
            edit: expect.objectContaining({
              allowMetadataLoss: false,
              outputFormat: 'keep',
            }),
          },
        ],
        true,
        expect.any(Function),
      ),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('treats tiff and gif sources keeping format as png targets that migrate', async () => {
    const startExport = vi.fn().mockImplementation(() => new Promise(() => {}));
    for (const format of ['tiff', 'gif', 'bmp', 'svg']) {
      const service = client({
        pickImages: vi
          .fn()
          .mockResolvedValue([{ ...sampleFile, format, hasAlpha: true }]),
        startExport,
      });
      const evidence = await service.fileEvidence('f1');
      service.fileEvidence = vi.fn().mockResolvedValue({
        ...evidence,
        icc: '存在',
        exifFields: 9,
        hasXmp: true,
        orientation: 6,
      });
      render(<App client={service} />);
      fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
      await screen.findAllByText(sampleFile.name);
      fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
      await waitFor(() =>
        expect(startExport).toHaveBeenCalledWith(
          [
            {
              id: 'f1',
              edit: expect.objectContaining({
                allowMetadataLoss: false,
                outputFormat: 'keep',
              }),
            },
          ],
          true,
          expect.any(Function),
        ),
      );
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      startExport.mockClear();
      cleanup();
    }
  });

  it('requires explicit consent before dropping metadata for webp targets', async () => {
    const startExport = vi.fn().mockImplementation(() => new Promise(() => {}));
    const service = client({
      pickImages: vi.fn().mockResolvedValue([sampleFile]),
      startExport,
    });
    const evidence = await service.fileEvidence('f1');
    service.fileEvidence = vi
      .fn()
      .mockResolvedValue({ ...evidence, icc: '存在', exifFields: 12 });
    render(<App client={service} />);
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    fireEvent.click(screen.getByRole('button', { name: '导出设置' }));
    fireEvent.change(screen.getByLabelText('输出格式'), {
      target: { value: 'webp' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('无法写入 WEBP 副本');
    expect(dialog).toHaveTextContent('改用 JPEG/PNG 可完整迁移');
    expect(startExport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认并导出' }));
    await waitFor(() =>
      expect(startExport).toHaveBeenCalledWith(
        [
          {
            id: 'f1',
            edit: expect.objectContaining({ allowMetadataLoss: true }),
          },
        ],
        true,
        expect.any(Function),
      ),
    );
  });

  it('warns that re-encoding invalidates unverified C2PA clues', async () => {
    const startExport = vi.fn().mockImplementation(() => new Promise(() => {}));
    const service = client({
      pickImages: vi.fn().mockResolvedValue([sampleFile]),
      startExport,
    });
    const evidence = await service.fileEvidence('f1');
    service.fileEvidence = vi.fn().mockResolvedValue({
      ...evidence,
      c2pa: { ...evidence.c2pa, present: true },
    });
    render(<App client={service} />);
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      '内容凭证不随副本保留',
    );
    fireEvent.click(screen.getByRole('button', { name: '确认并导出' }));
    await waitFor(() =>
      expect(startExport).toHaveBeenCalledWith(
        [
          {
            id: 'f1',
            edit: expect.objectContaining({ allowMetadataLoss: false }),
          },
        ],
        true,
        expect.any(Function),
      ),
    );
  });

  it('confirms metadata changes and keeps them in the original container', async () => {
    const startExport = vi.fn().mockImplementation(() => new Promise(() => {}));
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          startExport,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    fireEvent.click(screen.getByRole('button', { name: '水印与声明' }));
    fireEvent.click(screen.getByRole('button', { name: '补充 / 改写' }));
    fireEvent.click(screen.getByRole('button', { name: '保存 1 张副本' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      '将补充文件内声明',
    );
    expect(startExport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认并导出' }));
    await waitFor(() =>
      expect(startExport).toHaveBeenCalledWith(
        [
          {
            id: 'f1',
            edit: expect.objectContaining({
              metadataOnly: true,
              metadataPolicy: 'addAigc',
            }),
          },
        ],
        true,
        expect.any(Function),
      ),
    );
  });

  it('never exports when the preflight read fails', async () => {
    const startExport = vi.fn();
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          fileEvidence: vi.fn().mockRejectedValue(new Error('unavailable')),
          startExport,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
    expect(
      await screen.findByText('导出前检查失败，尚未写入文件。请重试。', {
        selector: '.action-note',
      }),
    ).toBeVisible();
    expect(startExport).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '导出 1 张图片' })).toBeEnabled();
  });
  it('does not overwrite preferences after failing to read them', async () => {
    const saveSettings = vi.fn();
    render(
      <App
        client={client({
          loadSettings: vi.fn().mockRejectedValue(new Error('read failed')),
          saveSettings,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByText(/已停止自动保存/u)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('keeps format limitations in the inline export settings', async () => {
    render(
      <App
        client={client({
          pickImages: vi
            .fn()
            .mockResolvedValue([{ ...sampleFile, format: 'bmp' }]),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    fireEvent.click(screen.getByRole('button', { name: '导出设置' }));
    expect(
      screen.getByText('BMP / TIFF / GIF / SVG 静态输出为 PNG。'),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: '导出检查' }),
    ).not.toBeInTheDocument();
  });
  it('keeps all asynchronous thumbnails when another thumbnail finishes first', async () => {
    let second!: (value: {
      pngBase64: string;
      width: number;
      height: number;
    }) => void;
    const filePreview = vi.fn((id: string) =>
      id === 'f1'
        ? Promise.resolve({ pngBase64: 'first', width: 100, height: 100 })
        : new Promise<{ pngBase64: string; width: number; height: number }>(
            (resolve) => {
              second = resolve;
            },
          ),
    );
    render(
      <App
        client={client({
          pickImages: vi
            .fn()
            .mockResolvedValue([
              sampleFile,
              { ...sampleFile, id: 'f2', name: '第二张.jpg' },
            ]),
          filePreview,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await waitFor(() =>
      expect(
        document.querySelector('img[src="data:image/png;base64,first"]'),
      ).not.toBeNull(),
    );
    await act(async () =>
      second({ pngBase64: 'second', width: 100, height: 100 }),
    );
    expect(
      document.querySelector('img[src="data:image/png;base64,second"]'),
    ).not.toBeNull();
  });

  it('does not claim browser settings were saved', () => {
    render(<App client={client({ available: false })} />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.queryByText('已自动保存')).not.toBeInTheDocument();
    expect(screen.getByText('浏览器预览，设置不会保存')).toBeVisible();
  });

  it('keeps failed settings saves visible instead of reporting success', async () => {
    render(
      <App
        client={client({
          saveSettings: vi.fn().mockRejectedValue(new Error('disk full')),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByText('保存失败，请重试')).toBeVisible();
    expect(screen.queryByText('已自动保存')).not.toBeInTheDocument();
  });

  it('lets the conversion background change from white to a custom color', () => {
    render(<App client={client()} />);
    fireEvent.click(screen.getByRole('button', { name: '格式转换' }));
    fireEvent.click(screen.getByRole('button', { name: '自定义' }));
    expect(screen.getByLabelText('背景色')).toBeVisible();
  });

  it('marks metadata previews as container-only even after another workspace edits pixels', async () => {
    const previewExport = vi.fn().mockResolvedValue({
      pngBase64: '',
      width: 100,
      height: 100,
      encodedBytes: 100,
      belowTarget: false,
      message: '',
    });
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          previewExport,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    fireEvent.click(screen.getByRole('button', { name: '水印与声明' }));
    fireEvent.click(screen.getByRole('button', { name: '补充 / 改写' }));
    fireEvent.click(screen.getByRole('button', { name: '更新预览' }));
    await waitFor(() =>
      expect(previewExport).toHaveBeenCalledWith(
        'f1',
        expect.objectContaining({ metadataOnly: true }),
      ),
    );
  });
  it('keeps the start page focused on importing images after connecting', async () => {
    const service = client();
    render(<App client={service} />);
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce());
    expect(screen.queryByText(/桌面框架连接/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/无需登录/u)).not.toBeInTheDocument();
    expect(screen.queryByText('本地处理')).not.toBeInTheDocument();
    expect(screen.queryByText('神兵系列')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '纯钧' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('纯钧')).toBeVisible();
    expect(screen.queryByText(/都在你的电脑上完成/u)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '图片压缩' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: '开始处理' })).toBeVisible();
    expect(screen.getByRole('button', { name: '选择图片' })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: /导出 \d+ 张图片/u }),
    ).not.toBeInTheDocument();
  });

  it('browser preview does not invoke native commands or claim desktop readiness', () => {
    const status = vi.fn();
    render(
      <App
        client={client({
          available: false,
          status,
        })}
      />,
    );
    expect(screen.queryByText('桌面框架连接就绪')).not.toBeInTheDocument();
    expect(status).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: /导出 \d+ 张图片/u }),
    ).not.toBeInTheDocument();
  });

  it('reports native bootstrap failure with a visible recovery action', async () => {
    render(
      <App
        client={client({
          status: vi.fn().mockRejectedValue(new Error('IPC unavailable')),
        })}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '桌面连接失败，请重新启动开发窗口。',
    );
  });

  it('does not treat unknown native status as success', async () => {
    render(
      <App
        client={client({
          status: vi.fn().mockResolvedValue('unknown'),
        })}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('未知状态');
  });

  it('switches workspaces and states unsupported recognition plainly', () => {
    render(<App client={client()} />);
    fireEvent.click(screen.getByRole('button', { name: '格式转换' }));
    expect(screen.getByRole('heading', { name: '格式转换' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '水印与声明' }));
    expect(screen.getByText(/自动识别未安装/u)).toBeVisible();
    expect(screen.getByText('待添加图片')).toBeVisible();
    expect(screen.queryByText(/未发现 AIGC 声明/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/不等于非 AI/u)).not.toBeInTheDocument();
  });

  it('removes repeated inspector instructions while retaining editable controls', () => {
    render(<App client={client()} />);
    fireEvent.click(screen.getByRole('button', { name: '格式转换' }));
    expect(screen.queryByText(/画质对 JPEG/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/能再省 60%/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/没有色彩管理引擎/u)).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'PNG 使用 8 位调色板（有损）' }),
    ).toBeEnabled();
    expect(screen.getByLabelText('目标格式')).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '裁剪尺寸' }));
    expect(screen.queryByText(/三分参考线已开启/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/会统一比例与锚点/u)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '应用全部' }),
    ).toBeInTheDocument();
  });

  it('removes compression and preview boilerplate while retaining quality and PNG controls', async () => {
    render(
      <App
        client={client({ pickImages: vi.fn().mockResolvedValue([sampleFile]) })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    expect(screen.queryByText(/当前按质量编码/u)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/有损模式按画质减少颜色/u),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/含来源或色彩字段的文件暂不重编码/u),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/预览不会修改源文件/u)).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /^画质/u })).toBeEnabled();
    expect(
      screen.getByRole('checkbox', { name: /PNG 转为 8 位调色板/u }),
    ).toBeEnabled();
  });

  it('keeps an import error visible and clears it when switching tools', async () => {
    render(
      <App
        client={client({
          pickImages: vi
            .fn()
            .mockRejectedValue(new Error('读取图片失败，请重试。')),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '读取图片失败，请重试。',
    );
    fireEvent.click(screen.getByRole('button', { name: '格式转换' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByText('读取图片失败，请重试。'),
    ).not.toBeInTheDocument();
  });

  it('keeps settings and empty history concise without nonfunctional update entries', () => {
    render(<App client={client()} />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.getByText('保存位置（本次会话）')).toBeVisible();
    expect(screen.getByRole('button', { name: '清理缓存' })).toBeEnabled();
    expect(screen.queryByText(/默认命名用于新工作区/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/清理缓存不影响/u)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /检查更新/u }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '处理记录' }));
    expect(
      screen.getByRole('heading', { name: '还没有本次结果' }),
    ).toBeVisible();
    expect(screen.queryByText(/完成一次导出后/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/结果与需要处理的异常/u)).not.toBeInTheDocument();
  });

  it('shows parsed evidence without repeated interpretation or field-writing explanations', async () => {
    render(
      <App
        client={client({ pickImages: vi.fn().mockResolvedValue([sampleFile]) })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    fireEvent.click(screen.getByRole('button', { name: '水印与声明' }));
    expect(screen.getByText('这份图没有读到 AIGC 声明')).toBeVisible();
    expect(screen.getByText('ContentProducer')).toBeVisible();
    expect(screen.queryByText(/也不等于人工创作/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/普通 Software/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '补充 / 改写' }));
    expect(screen.getByLabelText('来源平台')).toBeEnabled();
    expect(screen.queryByText(/内置清单只是/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/平台名称只按/u)).not.toBeInTheDocument();
  });

  it('edits the current export inline without changing default naming', async () => {
    const startExport = vi.fn().mockImplementation(() => new Promise(() => {}));
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const pickOutput = vi
      .fn()
      .mockResolvedValue({ id: 'o1', label: '本次输出' });
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          startExport,
          saveSettings,
          pickOutput,
          loadSettings: vi.fn().mockResolvedValue({
            concurrency: 1,
            historyEnabled: true,
            recursiveFolders: false,
            conflict: 'number',
            prefix: '',
            suffix: '_纯钧',
          }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findAllByText(sampleFile.name);
    const toggle = screen.getByRole('button', { name: '导出设置' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.change(screen.getByLabelText('前缀'), {
      target: { value: '本次_' },
    });
    fireEvent.change(screen.getByLabelText('后缀'), {
      target: { value: '_副本' },
    });
    fireEvent.change(screen.getByLabelText('重名处理'), {
      target: { value: 'skip' },
    });
    fireEvent.change(screen.getByLabelText('输出格式'), {
      target: { value: 'png' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: '保存到：原目录 / 纯钧导出' }),
    );
    expect(
      await screen.findByRole('button', { name: '保存到：本次输出' }),
    ).toBeVisible();
    fireEvent.keyDown(screen.getByLabelText('前缀'), { key: 'Escape' });
    expect(
      screen.queryByRole('heading', { name: '本次导出' }),
    ).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
    await waitFor(() =>
      expect(startExport).toHaveBeenCalledWith(
        [
          {
            id: 'f1',
            edit: expect.objectContaining({
              prefix: '本次_',
              suffix: '_副本',
              conflict: 'skip',
              outputFormat: 'png',
            }),
          },
        ],
        true,
        expect.any(Function),
      ),
    );
    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    expect(saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prefix: '',
        suffix: '_纯钧',
        conflict: 'number',
      }),
    );
  });

  it('starts ordinary exports from the workspace without an export check page', async () => {
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          filePreview: vi
            .fn()
            .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
          startExport: vi.fn().mockImplementation(() => new Promise(() => {})),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
    expect(
      await screen.findByRole('heading', { name: '正在处理' }),
    ).toBeVisible();
    expect(screen.getByText(/正在处理第 1 \/ 1 张/u)).toBeVisible();
  });

  it('moves the progress bar on stage events instead of only per finished file', async () => {
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          filePreview: vi
            .fn()
            .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
          startExport: vi.fn((_files, _write, onEvent) => {
            onEvent({
              kind: 'progress',
              jobId: 'job1',
              done: 0,
              total: 1,
              name: '山湖晨雾.jpg',
              phase: '编码',
              fraction: 0.42,
            });
            return new Promise<never>(() => {});
          }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
    expect(await screen.findByText('42%')).toBeVisible();
    const fill = document.querySelector('.bar span') as HTMLElement;
    expect(fill.style.width).toBe('42%');
    expect(document.querySelector('.progress-file')?.textContent).toContain(
      '编码',
    );
  });

  it('defaults PNG to palette compression and lets it switch back to lossless', async () => {
    const service = client({
      pickImages: vi.fn().mockResolvedValue([sampleFile]),
    });
    render(<App client={service} />);
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    const toggle = screen.getByRole('checkbox', {
      name: /PNG 转为 8 位调色板/u,
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '更新预览' }));
    await waitFor(() =>
      expect(service.previewExport).toHaveBeenCalledWith(
        'f1',
        expect.objectContaining({ pngLossy: false }),
      ),
    );
  });

  it('offers built-in platform presets for AIGC declarations', async () => {
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          filePreview: vi
            .fn()
            .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '水印与声明' }));
    fireEvent.click(screen.getByRole('button', { name: '补充 / 改写' }));
    const preset = screen.getByRole('combobox', { name: /来源平台/u });
    expect(
      screen.getByRole('option', { name: '即梦/豆包' }),
    ).toBeInTheDocument();
    fireEvent.change(preset, { target: { value: '即梦/豆包' } });
    expect(screen.getByLabelText(/声明主体/u)).toHaveValue('即梦/豆包');
    expect(screen.queryByText(/不会写入厂商原始编号/u)).not.toBeInTheDocument();
  });

  it('lists per-file results and offers preview, copy and reveal actions', async () => {
    const report = {
      jobId: 'job1',
      success: 1,
      skipped: 0,
      failed: 1,
      belowTarget: 0,
      savedBytes: 5032000,
      outputLabel: '纯钧导出',
      items: [
        {
          id: 'f1',
          name: '山湖晨雾.jpg',
          state: 'success',
          message: '已写出副本并回读',
          outputName: '山湖晨雾_纯钧.jpg',
          outputPath: 'C:/out/山湖晨雾_纯钧.jpg',
          bytes: 21000,
          sourceBytes: 5053000,
          savedBytes: 5032000,
        },
        {
          id: 'f2',
          name: '旧照片.heic',
          state: 'failed',
          message: 'HEIC 解码未接入',
          outputName: '',
          outputPath: '',
          bytes: 0,
          sourceBytes: 0,
          savedBytes: 0,
        },
      ],
    };
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          filePreview: vi
            .fn()
            .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
          startExport: vi.fn().mockResolvedValue(report),
          exportThumb: vi.fn().mockResolvedValue('iVBORw0KGgo='),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
    expect(
      await screen.findByRole('button', { name: '预览 山湖晨雾.jpg' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: '复制 山湖晨雾.jpg' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: '打开 山湖晨雾.jpg 所在文件夹' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: '预览 旧照片.heic' }),
    ).toBeDisabled();
    expect(screen.getByText('HEIC 解码未接入')).toBeVisible();
    expect(
      await screen.findByAltText('山湖晨雾.jpg 缩略图'),
    ).toBeInTheDocument();
    expect(screen.queryByAltText('旧照片.heic 缩略图')).toBeNull();
  });

  it('retries failed and below-target items with their original parameters', async () => {
    const startExport = vi.fn();
    const second = { ...sampleFile, id: 'f2', name: '第二张.jpg' };
    const report = {
      jobId: 'job1',
      success: 0,
      skipped: 0,
      failed: 1,
      belowTarget: 1,
      cancelled: 0,
      savedBytes: 0,
      outputLabel: '纯钧导出',
      items: [
        {
          id: 'f1',
          name: '山湖晨雾.jpg',
          state: 'below_target',
          message: '未达到目标体积',
          outputName: '山湖晨雾_纯钧.jpg',
          outputPath: 'C:/out/山湖晨雾_纯钧.jpg',
          bytes: 21000,
          sourceBytes: 5053000,
          savedBytes: 5032000,
        },
        {
          id: 'f2',
          name: '第二张.jpg',
          state: 'failed',
          message: '写入失败',
          outputName: '',
          outputPath: '',
          bytes: 0,
          sourceBytes: 0,
          savedBytes: 0,
        },
      ],
    };
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile, second]),
          filePreview: vi
            .fn()
            .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
          startExport,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    startExport.mockResolvedValue(report);
    fireEvent.click(screen.getByRole('button', { name: '导出 2 张图片' }));
    const retry = await screen.findByRole('button', { name: '重试失败项' });
    expect(retry).toBeEnabled();
    // 未达标项也要重试：此前只筛 failed，below_target 会被漏掉。
    fireEvent.click(retry);
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(2));
    const [, secondPayload] = startExport.mock.calls;
    expect(secondPayload[0].map((file: { id: string }) => file.id)).toEqual([
      'f1',
      'f2',
    ]);
    // 重试沿用导出时的参数快照，而不是重建当前工作区参数。
    expect(secondPayload[0]).toEqual(startExport.mock.calls[0][0]);
  });

  it('undoes and redoes parameter edits from the keyboard', async () => {
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          filePreview: vi
            .fn()
            .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    const quality = screen.getByRole('slider', { name: /画质/u });
    fireEvent.change(quality, { target: { value: '55' } });
    fireEvent.keyDown(window, {
      key: 'z',
      ctrlKey: true,
    });
    expect(screen.getByRole('slider', { name: /画质/u })).toHaveValue('80');
    // Ctrl+Shift+Z 重做：恢复被撤销的修改。
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('slider', { name: /画质/u })).toHaveValue('55');
    // 新修改会清空重做栈：撤销后不能再重做到旧值。
    fireEvent.change(quality, { target: { value: '70' } });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.change(quality, { target: { value: '90' } });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('slider', { name: /画质/u })).toHaveValue('90');
  });

  it('discards a stale preview that resolves after parameters changed', async () => {
    let resolvePreview:
      | ((value: {
          pngBase64: string;
          width: number;
          height: number;
          encodedBytes: number;
          belowTarget: boolean;
          message: string;
        }) => void)
      | undefined;
    const previewExport = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    );
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          filePreview: vi
            .fn()
            .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
          previewExport,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '更新预览' }));
    await waitFor(() => expect(previewExport).toHaveBeenCalled());
    // 预览还在生成时改参数：旧结果回来必须被丢弃并提示。
    fireEvent.change(screen.getByRole('slider', { name: /画质/u }), {
      target: { value: '42' },
    });
    act(() => {
      resolvePreview?.({
        pngBase64: '',
        width: 100,
        height: 100,
        encodedBytes: 1234,
        belowTarget: false,
        message: '旧参数的结果',
      });
    });
    await waitFor(() =>
      expect(screen.getAllByText(/预览已过期/u).length).toBeGreaterThan(0),
    );
  });

  it('saves and restores a workspace draft with its parameters', async () => {
    const saveDraft = vi.fn().mockResolvedValue(undefined);
    const service = client({
      pickImages: vi.fn().mockResolvedValue([sampleFile]),
      filePreview: vi
        .fn()
        .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
      saveDraft,
    });
    render(<App client={service} />);
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    fireEvent.change(screen.getByRole('slider', { name: /画质/u }), {
      target: { value: '55' },
    });
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(saveDraft).toHaveBeenCalled());
    const [ids, document] = saveDraft.mock.calls[0];
    expect(ids).toEqual(['f1']);
    expect(JSON.parse(document as string)).toMatchObject({
      version: 1,
      edit: expect.objectContaining({ quality: 55 }),
    });
    // 恢复：文件与参数都回来（新会话里文件列表为空）。
    service.loadDraft = vi.fn().mockResolvedValue({
      files: [sampleFile],
      document,
    });
    fireEvent.click(screen.getByRole('button', { name: '恢复草稿' }));
    await waitFor(() => expect(service.loadDraft).toHaveBeenCalled());
    // 恢复反馈先出现在设置页（切换工具会清掉遗留提示）。
    expect(await screen.findByText(/已恢复草稿/u)).toBeInTheDocument();
    // 回到工作区：文件与保存时的参数都在。
    fireEvent.click(screen.getByRole('button', { name: '图片压缩' }));
    expect((await screen.findAllByText('山湖晨雾.jpg')).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole('slider', { name: /画质/u })).toHaveValue('55');
  });

  it('restores the last chosen output directory on startup', async () => {
    render(
      <App
        client={client({
          currentOutput: vi.fn().mockResolvedValue({
            id: 'o9',
            label: '我的导出',
          }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    // 保存位置按钮显示的是恢复的目录名。
    expect(
      await screen.findByRole('button', { name: '我的导出' }),
    ).toBeInTheDocument();
  });

  it('combines a per-file crop draft with later global compress settings', async () => {
    const startExport = vi.fn().mockResolvedValue({
      jobId: 'job1',
      success: 2,
      skipped: 0,
      failed: 0,
      belowTarget: 0,
      cancelled: 0,
      savedBytes: 0,
      outputLabel: '纯钧导出',
      items: [],
    });
    const second = { ...sampleFile, id: 'f2', name: '第二张.jpg' };
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile, second]),
          filePreview: vi
            .fn()
            .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
          startExport,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    // 在裁剪工作区给第一张定 1:1 裁剪（写入逐图草稿）。
    fireEvent.click(screen.getByRole('button', { name: '裁剪尺寸' }));
    fireEvent.click(screen.getByRole('button', { name: '1 : 1' }));
    // 回压缩工作区改全局画质，然后导出。
    fireEvent.click(screen.getByRole('button', { name: '图片压缩' }));
    fireEvent.change(screen.getByRole('slider', { name: /画质/u }), {
      target: { value: '55' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导出 2 张图片' }));
    await waitFor(() => expect(startExport).toHaveBeenCalled());
    const payload = startExport.mock.calls[0][0] as Array<{
      id: string;
      edit: Record<string, unknown>;
    }>;
    // 第一张：裁剪草稿 + 新的全局画质组合，而不是丢掉裁剪或用旧画质。
    const cropped = payload.find((item) => item.id === 'f1')?.edit ?? {};
    expect(cropped.useCrop).toBe(true);
    expect(cropped.cropW).toBe(3024); // 1:1 以较短边为基准
    expect(cropped.quality).toBe(55);
    // 第二张没有草稿：只按全局参数，不带裁剪。
    const plain = payload.find((item) => item.id === 'f2')?.edit ?? {};
    expect(plain.useCrop).toBe(false);
    expect(plain.quality).toBe(55);
  });

  it('exports the whole list after applying a crop to all images', async () => {
    const startExport = vi.fn().mockResolvedValue({
      jobId: 'job1',
      success: 2,
      skipped: 0,
      failed: 0,
      belowTarget: 0,
      cancelled: 0,
      savedBytes: 0,
      outputLabel: '纯钧导出',
      items: [],
    });
    const second = {
      ...sampleFile,
      id: 'f2',
      name: '第二张.jpg',
      width: 2000,
      height: 1000,
    };
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile, second]),
          filePreview: vi
            .fn()
            .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
          startExport,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '裁剪尺寸' }));
    fireEvent.click(screen.getByRole('button', { name: '1 : 1' }));
    fireEvent.click(screen.getByRole('button', { name: '应用全部' }));
    // 裁剪工作区的“应用并继续”现在按整张列表提交，两张都带各自的裁剪。
    fireEvent.click(await screen.findByRole('button', { name: '应用并继续' }));
    await waitFor(() => expect(startExport).toHaveBeenCalled());
    const payload = startExport.mock.calls[0][0] as Array<{
      id: string;
      edit: Record<string, unknown>;
    }>;
    expect(payload).toHaveLength(2);
    for (const item of payload) {
      expect(item.edit.useCrop).toBe(true);
      expect(item.edit.cropW).toBeGreaterThan(0);
    }
    // 每张的裁剪按各自原尺寸换算，不是硬拷贝同一像素值。
    expect(payload[0].edit.cropW).not.toBe(payload[1].edit.cropW);
  });

  it('hides saved history while recording is off and shows it again when on', async () => {
    const service = client({
      pickImages: vi.fn().mockResolvedValue([sampleFile]),
      filePreview: vi
        .fn()
        .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
      listHistory: vi
        .fn()
        .mockResolvedValue([
          { id: 'job1', label: '导出', success: 3, failed: 0, belowTarget: 0 },
        ]),
    });
    render(<App client={service} />);
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '处理记录' }));
    expect(await screen.findByText('本机历史')).toBeVisible();
    // 关闭“保留本机处理记录”：列表立即消失，显示关闭说明。
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(
      screen.getByRole('checkbox', { name: /保留本机处理记录/u }),
    );
    fireEvent.click(screen.getByRole('button', { name: '处理记录' }));
    expect(await screen.findByText('本机记录已关闭')).toBeVisible();
    expect(screen.queryByText('本机历史')).not.toBeInTheDocument();
    // 重新打开：保存的记录恢复显示（数据从未被删）。
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(
      screen.getByRole('checkbox', { name: /保留本机处理记录/u }),
    );
    fireEvent.click(screen.getByRole('button', { name: '处理记录' }));
    expect(await screen.findByText('本机历史')).toBeVisible();
  });

  it('reports how many items were cancelled without running', async () => {
    const report = {
      jobId: 'job1',
      success: 1,
      skipped: 0,
      failed: 0,
      belowTarget: 0,
      cancelled: 2,
      savedBytes: 5032000,
      outputLabel: '纯钧导出',
      items: [
        {
          id: 'f1',
          name: '山湖晨雾.jpg',
          state: 'success',
          message: '已写出副本并回读',
          outputName: '山湖晨雾_纯钧.jpg',
          outputPath: 'C:/out/山湖晨雾_纯钧.jpg',
          bytes: 21000,
          sourceBytes: 5053000,
          savedBytes: 5032000,
        },
      ],
    };
    render(
      <App
        client={client({
          pickImages: vi.fn().mockResolvedValue([sampleFile]),
          filePreview: vi
            .fn()
            .mockResolvedValue({ pngBase64: '', width: 100, height: 100 }),
          startExport: vi.fn().mockResolvedValue(report),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    expect((await screen.findAllByText('山湖晨雾.jpg'))[0]).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '导出 1 张图片' }));
    // 摘要标题与完成通知都会带上未执行数量。
    await waitFor(() =>
      expect(screen.getAllByText(/2 项因取消未执行/u).length).toBeGreaterThan(
        0,
      ),
    );
  });
});

const sampleFile = {
  id: 'f1',
  name: '山湖晨雾.jpg',
  format: 'jpeg',
  width: 4032,
  height: 3024,
  bytes: 5053000,
  status: 'ready',
  message: '',
  animated: false,
  pages: 1,
  hasAlpha: false,
};
