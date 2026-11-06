import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultEdit, type JobEvent } from './types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
  receive: (event: { payload: JobEvent }) => {
    void event;
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: mocks.invoke,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
import { desktop } from './desktop';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockImplementation(async (_name, handler) => {
    mocks.receive = handler;
    return mocks.stop;
  });
});

describe('export event subscription', () => {
  it('releases the listener when starting a job fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('start failed'));
    await expect(
      desktop.startExport([{ id: 'g1', edit: defaultEdit() }], false, vi.fn()),
    ).rejects.toThrow('start failed');
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it('rejects a buffered terminal event without a report and releases the listener', async () => {
    mocks.invoke.mockImplementation(async () => {
      mocks.receive({
        payload: {
          kind: 'done',
          jobId: 'job1',
          done: 0,
          total: 1,
          name: '',
          phase: '',
          fraction: 1,
        },
      });
      return 'job1';
    });
    await expect(
      desktop.startExport([{ id: 'g1', edit: defaultEdit() }], false, vi.fn()),
    ).rejects.toThrow('任务结束时没有结果');
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
});
