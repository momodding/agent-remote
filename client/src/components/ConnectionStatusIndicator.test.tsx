import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { AgenticRemoteAPI } from '../lib/api';
import { ConnectionStatusIndicator } from './ConnectionStatusIndicator';

const deferred = () => Promise.withResolvers<void>();
const api = (ping: jest.Mock) => ({ ping } as unknown as AgenticRemoteAPI);
const label = (tree: ReactTestRenderer, text: string) => tree.root.findByProps({ accessibilityLabel: text });

let now = 100;

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  now = 100;
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('renders connecting, ready latency, error, and retry states', async () => {
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const ping = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
  let tree: ReactTestRenderer;
  act(() => { tree = create(<ConnectionStatusIndicator api={api(ping)} showLatency />); });

  expect(label(tree!, 'Connecting')).toBeTruthy();
  now = 142;
  await act(async () => { first.resolve(); await first.promise; });
  expect(label(tree!, 'Ready · 42 ms')).toBeTruthy();

  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(label(tree!, 'Ready · 42 ms')).toBeTruthy();
  await act(async () => { second.reject(new Error('offline')); try { await second.promise; } catch {} });
  expect(label(tree!, 'Error · 42 ms')).toBeTruthy();

  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(label(tree!, 'Connecting · 42 ms')).toBeTruthy();
  act(() => tree!.unmount());
});

it('aborts, clears polling, and ignores a stale response after API change', async () => {
  const stale = deferred();
  const current = deferred();
  const oldPing = jest.fn().mockReturnValue(stale.promise);
  const newPing = jest.fn().mockReturnValue(current.promise);
  let oldSignal: AbortSignal | undefined;
  oldPing.mockImplementation((signal: AbortSignal) => { oldSignal = signal; return stale.promise; });
  let tree: ReactTestRenderer;
  act(() => { tree = create(<ConnectionStatusIndicator api={api(oldPing)} />); });
  const clear = jest.spyOn(globalThis, 'clearInterval');

  act(() => { tree!.update(<ConnectionStatusIndicator api={api(newPing)} />); });
  expect(oldSignal?.aborted).toBe(true);
  expect(clear).toHaveBeenCalled();
  await act(async () => { stale.resolve(); await stale.promise; });
  expect(label(tree!, 'Connecting')).toBeTruthy();
  await act(async () => { current.reject(new Error('offline')); try { await current.promise; } catch {} });
  expect(label(tree!, 'Error')).toBeTruthy();
  act(() => tree!.unmount());
  expect(clear).toHaveBeenCalledTimes(2);
});

it('renders Error without polling when no API is selected', () => {
  let tree: ReactTestRenderer;
  act(() => { tree = create(<ConnectionStatusIndicator api={null} />); });
  expect(label(tree!, 'Error')).toBeTruthy();
  expect(jest.getTimerCount()).toBe(0);
  act(() => tree!.unmount());
});
