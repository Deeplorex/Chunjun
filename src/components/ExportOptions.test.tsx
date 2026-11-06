import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExportConfirmation } from './ExportOptions';

describe('scrollable export confirmation', () => {
  it('keeps scrollbar and viewport focus inside the dialog and allows Escape', () => {
    const cancel = vi.fn();
    render(
      <ExportConfirmation
        warnings={['透明区域将被填充']}
        blockers={[]}
        onCancel={cancel}
        onConfirm={vi.fn()}
      />,
    );
    const view = screen.getByRole('region', { name: '导出风险' });
    Object.defineProperties(view, {
      clientWidth: { value: 500 },
      clientHeight: { value: 100 },
      scrollWidth: { value: 500 },
      scrollHeight: { value: 400 },
    });
    fireEvent.scroll(view);
    const bar = screen.getByRole('scrollbar', { name: '导出风险垂直滚动条' });
    bar.focus();
    fireEvent.keyDown(bar, { key: 'Tab' });
    expect(view).toHaveFocus();
    fireEvent.keyDown(view, { key: 'Tab', shiftKey: true });
    expect(bar).toHaveFocus();
    fireEvent.keyDown(bar, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
