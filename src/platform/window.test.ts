import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  maximized: false,
  listeners: [] as Array<() => void>,
  progress: [] as Array<unknown>,
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({
  ProgressBarStatus: {
    None: 'none',
    Normal: 'normal',
    Indeterminate: 'indeterminate',
    Paused: 'paused',
    Error: 'error',
  },
  getCurrentWindow: () => ({
    isMaximized: async () => state.maximized,
    onResized: async (handler: () => void) => {
      state.listeners.push(handler);
      return () => {
        state.listeners = [];
      };
    },
    toggleMaximize: async () => {},
    minimize: async () => {},
    close: async () => {},
    setProgressBar: async (value: unknown) => {
      state.progress.push(value);
    },
  }),
}));

import { setTaskbarProgress, taskbarProgress, watchMaximized } from './window';

describe('watchMaximized', () => {
  it('follows the real window state instead of only reacting to clicks', async () => {
    state.maximized = false;
    state.listeners = [];
    const seen: boolean[] = [];

    const stop = await watchMaximized((value) => seen.push(value));
    expect(seen).toEqual([false]);

    state.maximized = true;
    const fire = state.listeners[0];
    fire();
    await vi.waitFor(() => expect(seen).toEqual([false, true]));

    stop();
    state.maximized = false;
    fire();
    await Promise.resolve();
    expect(seen).toEqual([false, true]);
  });
});

describe('taskbar progress', () => {
  it('maps job events to clamped taskbar states', () => {
    expect(taskbarProgress(0.42, false)).toEqual({
      kind: 'progress',
      fraction: 0.42,
    });
    expect(taskbarProgress(1.7, false)).toEqual({
      kind: 'progress',
      fraction: 1,
    });
    expect(taskbarProgress(-0.2, false)).toEqual({
      kind: 'progress',
      fraction: 0,
    });
    expect(taskbarProgress(0.3, true)).toEqual({
      kind: 'paused',
      fraction: 0.3,
    });
    // 非数值（NaN）不驱动进度条。
    expect(taskbarProgress(Number.NaN, false)).toEqual({ kind: 'none' });
  });

  it('sends percentages to the taskbar and clears it afterwards', async () => {
    state.progress = [];
    await setTaskbarProgress(taskbarProgress(0.42, false));
    await setTaskbarProgress(taskbarProgress(0.42, true));
    await setTaskbarProgress({ kind: 'none' });
    expect(state.progress).toEqual([
      { status: 'normal', progress: 42 },
      { status: 'paused' },
      { status: 'none' },
    ]);
  });
});
