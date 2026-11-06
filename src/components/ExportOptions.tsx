import { useEffect, useRef } from 'react';
import type { EditDraft } from '../platform/types';
import { Icon } from './Icon';
import { ScrollArea } from './ScrollArea';

export type Naming = Pick<EditDraft, 'prefix' | 'suffix' | 'conflict'>;

export function ExportNamingFields({
  value,
  onChange,
}: {
  value: Naming;
  onChange: (patch: Partial<Naming>) => void;
}) {
  return (
    <div className="export-naming-fields">
      <label className="field">
        <span>前缀</span>
        <input
          value={value.prefix}
          onChange={(event) => onChange({ prefix: event.target.value })}
        />
      </label>
      <label className="field">
        <span>后缀</span>
        <input
          value={value.suffix}
          onChange={(event) => onChange({ suffix: event.target.value })}
        />
      </label>
      <label className="field">
        <span>重名处理</span>
        <select
          value={value.conflict}
          onChange={(event) =>
            onChange({ conflict: event.target.value as Naming['conflict'] })
          }
        >
          <option value="number">自动编号</option>
          <option value="skip">跳过</option>
          <option value="replace">替换副本（源图不动）</option>
        </select>
      </label>
    </div>
  );
}

export function ExportOptions({
  edit,
  outputLabel,
  onOutput,
  onResetOutput,
  onNaming,
  onFormat,
  openAfter,
  onOpenAfter,
  onClose,
}: {
  edit: EditDraft;
  outputLabel: string;
  onOutput: () => void;
  onResetOutput: () => void;
  onNaming: (patch: Partial<Naming>) => void;
  onFormat: (format: EditDraft['outputFormat']) => void;
  openAfter: boolean;
  onOpenAfter: (value: boolean) => void;
  onClose: () => void;
}) {
  return (
    <ScrollArea
      as="section"
      label="本次导出"
      id="export-options"
      className="export-options"
      aria-labelledby="export-options-title"
    >
      <header>
        <h3 id="export-options-title">本次导出</h3>
        <button className="text-button" type="button" onClick={onClose}>
          收起设置
          <Icon name="chevron-down" size={16} />
        </button>
      </header>
      <div className="export-options-grid">
        <div className="field">
          <span>保存位置</span>
          <button
            className="secondary path-button"
            type="button"
            onClick={onOutput}
          >
            {outputLabel}
          </button>
          {outputLabel !== '原目录 / 纯钧导出' && (
            <button
              className="text-button reset-output"
              type="button"
              onClick={onResetOutput}
            >
              使用原图目录
            </button>
          )}
        </div>
        <label className="field">
          <span>输出格式</span>
          <select
            disabled={edit.metadataOnly}
            value={edit.metadataOnly ? 'keep' : edit.outputFormat}
            onChange={(event) =>
              onFormat(event.target.value as EditDraft['outputFormat'])
            }
          >
            <option value="keep">
              {edit.metadataOnly ? '原容器（仅改元数据）' : '保持原格式'}
            </option>
            <option value="jpeg">JPEG (.jpg)</option>
            <option value="png">PNG</option>
            <option value="webp">WebP（无损）</option>
            <option value="avif">AVIF</option>
          </select>
        </label>
        <ExportNamingFields value={edit} onChange={onNaming} />
      </div>
      <footer>
        <p className="hint">
          {edit.prefix}
          {'{原文件名}'}
          {edit.suffix}.
          {edit.metadataOnly || edit.outputFormat === 'keep'
            ? '{格式}'
            : edit.outputFormat === 'jpeg'
              ? 'jpg'
              : edit.outputFormat}{' '}
          · 仅用于本次工作区
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={openAfter}
            onChange={(event) => onOpenAfter(event.target.checked)}
          />
          <span>导出后打开文件夹</span>
        </label>
      </footer>
      {!edit.metadataOnly && edit.outputFormat === 'keep' && (
        <p className="hint">BMP / TIFF / GIF / SVG 静态输出为 PNG。</p>
      )}
      {!edit.metadataOnly &&
        (edit.outputFormat === 'webp' || edit.outputFormat === 'avif') && (
          <p className="hint">
            WebP / AVIF 副本不承载 EXIF / ICC / XMP，导出前会请求确认。
          </p>
        )}
    </ScrollArea>
  );
}

export function ExportConfirmation({
  warnings,
  blockers,
  onCancel,
  onConfirm,
}: {
  warnings: string[];
  blockers: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <div className="export-confirmation-backdrop">
      <ScrollArea
        label="导出风险"
        ref={dialog}
        className="export-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="export-confirmation-title"
        aria-describedby="export-confirmation-details"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
          if (event.key === 'Tab') {
            const buttons = dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), [tabindex="0"]',
            );
            if (!buttons?.length) return;
            const first = buttons[0],
              last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <Icon name="warning" size={24} />
          <h2 id="export-confirmation-title">
            {blockers.length ? '需要调整导出选项' : '确认这些变化后导出'}
          </h2>
        </header>
        <div id="export-confirmation-details">
          <ul>
            {[...blockers, ...warnings].map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
          <p className="hint">源文件保持只读，只导出处理后的副本。</p>
        </div>
        <footer>
          <button
            ref={cancel}
            className="secondary"
            type="button"
            onClick={onCancel}
          >
            返回调整
          </button>
          {!blockers.length && (
            <button className="primary" type="button" onClick={onConfirm}>
              确认并导出
            </button>
          )}
        </footer>
      </ScrollArea>
    </div>
  );
}
