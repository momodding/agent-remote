jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Terminal } from './Terminal.web';

const mockInputSubscription = { dispose: jest.fn() };
let mockOnData: ((data: string) => void) | undefined;
const mockTerminal = {
  cols: 80,
  rows: 24,
  loadAddon: jest.fn(),
  open: jest.fn(),
  onData: jest.fn((handler: (data: string) => void) => {
    mockOnData = handler;
    return mockInputSubscription;
  }),
  write: jest.fn(),
  clear: jest.fn(),
  dispose: jest.fn(),
};
const mockFit = { fit: jest.fn() };

jest.mock('xterm', () => ({ Terminal: jest.fn(() => mockTerminal) }));
jest.mock('xterm-addon-fit', () => ({ FitAddon: jest.fn(() => mockFit) }));
jest.mock('xterm/css/xterm.css', () => ({}));

let resize: (() => void) | undefined;
const observe = jest.fn();
const disconnect = jest.fn();

globalThis.ResizeObserver = class {
  constructor(callback: ResizeObserverCallback) {
    resize = () => callback([], this);
  }

  observe = observe;
  unobserve = jest.fn();
  disconnect = disconnect;
} as unknown as typeof ResizeObserver;

let rafCallback: FrameRequestCallback | undefined;
const rafSpy = jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
  rafCallback = cb;
  return 1;
});

describe('web terminal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOnData = undefined;
    resize = undefined;
    rafCallback = undefined;
  });

  it('writes output deltas and connects terminal input, sizing, and cleanup', () => {
    const onInput = jest.fn();
    const onResize = jest.fn();
    const element = {} as HTMLDivElement;
    let tree: ReactTestRenderer;

    act(() => {
      tree = create(<Terminal output="hello" onInput={onInput} onResize={onResize} />, {
        createNodeMock: () => element,
      });
    });

    expect(mockTerminal.open).toHaveBeenCalledWith(element);
    expect(mockTerminal.loadAddon).toHaveBeenCalledWith(mockFit);
    expect(observe).toHaveBeenCalledWith(element);
    expect(mockTerminal.write).toHaveBeenCalledTimes(1);
    expect(mockTerminal.write).toHaveBeenCalledWith('hello');
    expect(mockFit.fit).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(80, 24);

    act(() => mockOnData?.('ls\r'));
    expect(onInput).toHaveBeenCalledWith('ls\r');

    act(() => tree!.update(<Terminal output="hello world" onInput={onInput} onResize={onResize} />));
    expect(mockTerminal.write).toHaveBeenLastCalledWith(' world');

    act(() => tree!.update(<Terminal output="replacement" onInput={onInput} onResize={onResize} />));
    expect(mockTerminal.clear).toHaveBeenCalledTimes(1);
    expect(mockTerminal.write).toHaveBeenLastCalledWith('replacement');

    act(() => resize?.());
    expect(mockFit.fit).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenCalledTimes(2);

    act(() => tree!.unmount());
    expect(mockInputSubscription.dispose).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(mockTerminal.dispose).not.toHaveBeenCalled();
    act(() => rafCallback?.(0));
    expect(mockTerminal.dispose).toHaveBeenCalledTimes(1);
  });

  it('defers xterm dispose until after any in-flight resize RAF drains', () => {
    const element = {} as HTMLDivElement;
    let tree: ReactTestRenderer;

    act(() => {
      tree = create(<Terminal output="" onInput={jest.fn()} onResize={jest.fn()} />, {
        createNodeMock: () => element,
      });
    });

    act(() => tree!.unmount());
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(mockTerminal.dispose).not.toHaveBeenCalled();

    act(() => rafCallback?.(0));
    expect(mockTerminal.dispose).toHaveBeenCalledTimes(1);
  });

  afterAll(() => {
    rafSpy.mockRestore();
  });
});
