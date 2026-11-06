import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScrollArea } from './ScrollArea';

function overflow() {
  const view = screen.getByRole('region', { name: '测试内容' });
  Object.defineProperties(view, {
    clientWidth: { value: 200, configurable: true },
    clientHeight: { value: 100, configurable: true },
    scrollWidth: { value: 500, configurable: true },
    scrollHeight: { value: 400, configurable: true },
  });
  fireEvent.scroll(view);
  return view;
}

describe('overlay scroll area', () => {
  it('clips fit previews without turning protruding crop handles into scrollbars', () => {
    render(
      <ScrollArea label="测试内容" scrollable={false}>
        <p>裁剪手柄</p>
      </ScrollArea>,
    );
    const view = overflow();
    view.scrollTop = 20;
    view.scrollLeft = 20;
    fireEvent.scroll(view);
    expect(screen.queryByRole('scrollbar')).not.toBeInTheDocument();
    expect(view.scrollTop).toBe(0);
    expect(view.scrollLeft).toBe(0);
    expect(view).not.toHaveAttribute('tabindex');
  });
  it('shows no scrollbar when content fits and follows native scroll position', () => {
    render(
      <ScrollArea label="测试内容">
        <button>内容操作</button>
      </ScrollArea>,
    );
    expect(screen.queryByRole('scrollbar')).not.toBeInTheDocument();
    const view = overflow();
    const bar = screen.getByRole('scrollbar', { name: '测试内容垂直滚动条' });
    expect(bar).toHaveAttribute('aria-controls', view.id);
    expect(bar).toHaveAttribute('aria-valuemax', '300');
    view.scrollTop = 150;
    fireEvent.scroll(view);
    expect(bar).toHaveAttribute('aria-valuenow', '150');
    expect(bar.querySelector('.scroll-thumb')).toHaveStyle({
      top: '37.5px',
      height: '25px',
    });
    expect(screen.getByRole('button', { name: '内容操作' })).toBeEnabled();
  });

  it('scrolls both axes with keyboard and forwards wheel input over the overlay', () => {
    render(
      <ScrollArea label="测试内容">
        <p>内容</p>
      </ScrollArea>,
    );
    const view = overflow();
    const vertical = screen.getByRole('scrollbar', {
      name: '测试内容垂直滚动条',
    });
    const horizontal = screen.getByRole('scrollbar', {
      name: '测试内容水平滚动条',
    });
    fireEvent.keyDown(vertical, { key: 'ArrowDown' });
    expect(view.scrollTop).toBe(40);
    fireEvent.keyDown(vertical, { key: 'PageDown' });
    expect(view.scrollTop).toBe(140);
    fireEvent.keyDown(vertical, { key: 'End' });
    expect(view.scrollTop).toBe(300);
    fireEvent.keyDown(vertical, { key: 'Home' });
    expect(view.scrollTop).toBe(0);
    fireEvent.keyDown(horizontal, { key: 'ArrowRight' });
    expect(view.scrollLeft).toBe(40);
    fireEvent.wheel(horizontal, { deltaX: 20 });
    expect(view.scrollLeft).toBe(60);
    fireEvent.wheel(vertical, { deltaY: 80 });
    expect(view.scrollTop).toBe(80);
    const wheel = new WheelEvent('wheel', {
      deltaY: 1,
      deltaMode: 1,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(vertical, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(view.scrollTop).toBe(120);
  });

  it('drags and clicks the overlay without changing the viewport size', () => {
    render(
      <ScrollArea label="测试内容">
        <p>内容</p>
      </ScrollArea>,
    );
    const view = overflow();
    const vertical = screen.getByRole('scrollbar', {
      name: '测试内容垂直滚动条',
    });
    Object.defineProperty(vertical, 'setPointerCapture', { value: vi.fn() });
    vi.spyOn(vertical, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      height: 100,
      width: 12,
      bottom: 100,
      right: 12,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent(
      vertical.querySelector('.scroll-thumb')!,
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 10 }),
    );
    fireEvent(
      vertical,
      new MouseEvent('pointermove', { bubbles: true, clientY: 85 }),
    );
    expect(view.scrollTop).toBe(300);
    fireEvent.pointerUp(vertical);
    fireEvent(
      vertical,
      new MouseEvent('pointermove', { bubbles: true, clientY: 10 }),
    );
    expect(view.scrollTop).toBe(300);
    fireEvent(
      vertical,
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 50 }),
    );
    expect(view.scrollTop).toBe(150);
    expect(view.clientWidth).toBe(200);
  });

  it('rechecks content and disconnects resize observers on unmount', () => {
    const callbacks: Array<ResizeObserverCallback> = [];
    const disconnect = vi.fn();
    const Observer = vi.fn(
      class {
        observe = vi.fn();
        disconnect = disconnect;
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
      },
    );
    vi.stubGlobal('ResizeObserver', Observer);
    try {
      const { unmount } = render(
        <ScrollArea label="测试内容">
          <p>内容</p>
        </ScrollArea>,
      );
      const view = overflow();
      Object.defineProperty(view, 'scrollHeight', {
        value: 100,
        configurable: true,
      });
      Object.defineProperty(view, 'scrollWidth', {
        value: 200,
        configurable: true,
      });
      act(() => callbacks[0]([], {} as ResizeObserver));
      expect(screen.queryByRole('scrollbar')).not.toBeInTheDocument();
      unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
