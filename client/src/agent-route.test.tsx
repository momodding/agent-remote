const mockKeyboardListeners = new Map<
  string,
  (event: { endCoordinates: { screenY: number } }) => void
>();
jest.mock("react-native", () => {
  const React = require("react");
  const element =
    (name: string) =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(name, props, children);
  const View = element("View");
  const dimensionsState = {
    current: { width: 390, height: 844, scale: 1, fontScale: 1 },
  };
  return {
    ActivityIndicator: element("ActivityIndicator"),
    Alert: { alert: jest.fn() },
    FlatList: ({
      ListEmptyComponent,
      data,
      renderItem,
      keyExtractor,
      ...props
    }: {
      ListEmptyComponent?: React.ReactNode;
      data?: unknown[];
      renderItem?: (info: { item: unknown; index: number }) => React.ReactNode;
      keyExtractor?: (item: unknown, index: number) => string;
    }) =>
      React.createElement(
        "FlatList",
        props,
        data && renderItem
          ? data.map((item, index) => {
              const el = renderItem({ item, index });
              const key = keyExtractor
                ? keyExtractor(item, index)
                : String(index);
              return React.isValidElement(el)
                ? React.cloneElement(el, { key })
                : el;
            })
          : ListEmptyComponent,
      ),
    Keyboard: {
      addListener: (
        name: string,
        callback: (event: { endCoordinates: { screenY: number } }) => void,
      ) => {
        mockKeyboardListeners.set(name, callback);
        return { remove: jest.fn(() => mockKeyboardListeners.delete(name)) };
      },
      dismiss: jest.fn(),
    },
    KeyboardAvoidingView: element("KeyboardAvoidingView"),
    Modal: ({
      visible,
      children,
      ...props
    }: {
      visible?: boolean;
      children?: React.ReactNode;
    }) => (visible ? React.createElement("Modal", props, children) : null),
    Platform: { OS: "web" },
    Pressable: element("Pressable"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element("Text"),
    TextInput: element("TextInput"),
    View,
    useColorScheme: () => "dark",
    useWindowDimensions: () => dimensionsState.current,
    __setWindowDimensions: (next: {
      width: number;
      height: number;
      scale?: number;
      fontScale?: number;
    }) => {
      dimensionsState.current = { scale: 1, fontScale: 1, ...next };
    },
  };
});
jest.mock("expo-crypto", () => ({ randomUUID: () => "generated-tab" }));

jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  return {
    SafeAreaView: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement("SafeAreaView", props, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock("expo-blur", () => ({ BlurView: () => null }));
jest.mock("@gorhom/bottom-sheet", () => {
  const React = require("react");
  return {
    BottomSheetBackdrop: () => null,
    BottomSheetModal: React.forwardRef(
      (
        { children, ...props }: { children?: React.ReactNode },
        ref: React.Ref<unknown>,
      ) => {
        React.useImperativeHandle(ref, () => ({
          present: () => {},
          dismiss: () => {},
        }));
        return React.createElement("BottomSheetModal", props, children);
      },
    ),
    BottomSheetView: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement("BottomSheetView", props, children),
    BottomSheetScrollView: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
    }) => React.createElement("BottomSheetScrollView", props, children),
  };
});
jest.mock("@expo/vector-icons/Feather", () => ({
  __esModule: true,
  default: () => null,
}));

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import AgentScreen from "../app/agent/[id]";
import type {
  AgentCapability,
  AgentEvent,
  AgentHistoryResponse,
} from "./protocol";
import type { Connection, ConnectionStore } from "./lib/connection";
import type { AgentWorkspaceTab } from "./lib/tabs/types";

const mockConnection: Connection = {
  name: "Test daemon",
  endpoint: "https://daemon.test",
  hostId: "host-1",
  token: "secret",
  fingerprint: "",
  skipFingerprintVerification: false,
  clientName: "test",
};
const mockStore: ConnectionStore = { connections: [mockConnection] };
const mockTab: AgentWorkspaceTab = {
  tabId: "agent-tab",
  daemonId: mockConnection.hostId,
  kind: "agent",
  title: "Agent",
  createdAt: 0,
  lastActiveAt: 0,
  pinned: false,
  agentSessionId: "agent-1",
  terminalSessionId: "terminal-1",
  state: "working",
  view: "chat",
};
let mockCapabilities: AgentCapability[] = [];
const mockTerminateAgent = jest.fn(async () => undefined);
const mockAgentHistory = jest.fn<Promise<AgentHistoryResponse>, [string]>(
  async () => ({ cursor: 0, events: [] }),
);
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  router: { replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ id: mockTab.tabId }),
}));
jest.mock("./lib/connection", () => ({
  loadConnections: jest.fn(async () => mockStore),
  getConnection: jest.fn(() => mockConnection),
}));
jest.mock("./lib/api", () => ({
  AgenticRemoteAPI: jest.fn(() => ({
    agent: jest.fn(async () => ({
      state: "working",
      capabilities: mockCapabilities,
    })),
    agentHistory: mockAgentHistory,
    runtimeSnapshot: jest.fn(async () => ({ topology: [] })),
    submitAgentPrompt: jest.fn(),
    abortAgent: jest.fn(),
    closeSession: jest.fn(),
    terminateAgent: mockTerminateAgent,
  })),
  APIError: class APIError extends Error {},
}));
let mockPTYHandler:
  | ((message: {
      type: string;
      state?: string;
      code?: string;
      message?: string;
    }) => void)
  | undefined;
jest.mock("./lib/daemon-channel", () => ({
  createDaemonChannel: jest.fn(() => ({
    subscribe: jest.fn((_channel: string, handler: typeof mockPTYHandler) => {
      mockPTYHandler = handler;
      return jest.fn();
    }),
    send: jest.fn(),
    closeChannel: jest.fn(),
  })),
}));
let mockHandleEvent: ((event: AgentEvent) => void) | undefined;
let mockHandleCursorExpired: (() => Promise<number>) | undefined;
jest.mock("./lib/runtime-channel", () => ({
  createRuntimeChannel: jest.fn(() => ({
    openAgentChannel: jest.fn(
      async (
        _agentId: string,
        _after: number,
        fn: (event: AgentEvent) => void,
        onCursorExpired?: () => Promise<number>,
      ) => {
        mockHandleEvent = fn;
        mockHandleCursorExpired = onCursorExpired;
        return { channelId: "agent-channel" };
      },
    ),
    closeChannel: jest.fn(),
  })),
}));
const mockDispatch = jest.fn((fn: unknown) =>
  typeof fn === "function"
    ? fn({ tabs: [mockTab], activeId: mockTab.tabId, layout: {} })
    : fn,
);
const mockCloseTab = jest.fn();
jest.mock("./lib/tabs/tab-store", () => ({
  useTabStore: () => ({
    state: { tabs: [mockTab], activeId: mockTab.tabId, layout: {} },
    dispatch: mockDispatch,
    closeTab: mockCloseTab,
  }),
  addTab: jest.fn(),
  updateTab: jest.fn((state: unknown) => state),
}));
jest.mock("./components/Terminal", () => ({ Terminal: () => null }));
jest.mock("./components/ShortcutKeyboard", () => ({
  ShortcutKeyboard: () => null,
}));
jest.mock("./components/TmuxPaneSheet", () => ({ TmuxPaneSheet: () => null }));

async function renderScreen(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer;
  await act(async () => {
    tree = create(<AgentScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree!;
}

beforeEach(() => {
  mockCapabilities = [];
  mockHandleEvent = undefined;
  mockHandleCursorExpired = undefined;
  mockAgentHistory.mockReset();
  mockAgentHistory.mockResolvedValue({ cursor: 0, events: [] });
  mockDispatch.mockClear();
  mockCloseTab.mockClear();
  mockTerminateAgent.mockClear();
  mockKeyboardListeners.clear();
  mockPTYHandler = undefined;
  mockTab.state = "working";
  require("react-native").__setWindowDimensions({ width: 390, height: 844 });
});

describe("AgentScreen capability gates", () => {
  it("shows terminal fallback and hides interactive controls without bridge capabilities", async () => {
    mockCapabilities = [
      { name: "chat", enabled: true },
      { name: "prompt", enabled: false },
      { name: "abort", enabled: false },
    ];
    const tree = await renderScreen();

    expect(
      tree.root.findByProps({
        accessibilityLabel: "Open Terminal to interact",
      }),
    ).toBeTruthy();
    expect(() =>
      tree.root.findByProps({ accessibilityLabel: "Send Prompt" }),
    ).toThrow();
    expect(() =>
      tree.root.findByProps({ accessibilityLabel: "Abort" }),
    ).toThrow();
    act(() => tree.unmount());
  });

  it("shows prompt and Abort only when the bridge enables them", async () => {
    mockCapabilities = [
      { name: "chat", enabled: true },
      { name: "prompt", enabled: true },
      { name: "abort", enabled: true },
    ];
    const tree = await renderScreen();

    expect(
      tree.root.findByProps({ accessibilityLabel: "Send Prompt" }),
    ).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: "Abort" })).toBeTruthy();
    expect(() =>
      tree.root.findByProps({
        accessibilityLabel: "Open Terminal to interact",
      }),
    ).toThrow();
    act(() => tree.unmount());
  });

  it("disables prompt/Abort when bridge fires a capability state event clearing them", async () => {
    mockCapabilities = [
      { name: "chat", enabled: true },
      { name: "prompt", enabled: true },
      { name: "abort", enabled: true },
    ];
    const tree = await renderScreen();
    expect(
      tree.root.findByProps({ accessibilityLabel: "Send Prompt" }),
    ).toBeTruthy();

    await act(async () => {
      mockHandleEvent?.({
        type: "state",
        agentId: "agent-1",
        state: "idle",
        capabilities: [
          { name: "chat", enabled: true },
          { name: "prompt", enabled: false },
          { name: "abort", enabled: false },
        ],
      });
    });

    expect(
      tree.root.findByProps({
        accessibilityLabel: "Open Terminal to interact",
      }),
    ).toBeTruthy();
    expect(() =>
      tree.root.findByProps({ accessibilityLabel: "Send Prompt" }),
    ).toThrow();
    expect(() =>
      tree.root.findByProps({ accessibilityLabel: "Abort" }),
    ).toThrow();
    act(() => tree.unmount());
  });

  it("enables prompt/Abort when bridge fires a capability state event enabling them", async () => {
    mockCapabilities = [
      { name: "chat", enabled: true },
      { name: "prompt", enabled: false },
      { name: "abort", enabled: false },
    ];
    const tree = await renderScreen();
    expect(
      tree.root.findByProps({
        accessibilityLabel: "Open Terminal to interact",
      }),
    ).toBeTruthy();

    await act(async () => {
      mockHandleEvent?.({
        type: "state",
        agentId: "agent-1",
        state: "working",
        capabilities: [
          { name: "chat", enabled: true },
          { name: "prompt", enabled: true },
          { name: "abort", enabled: true },
        ],
      });
    });

    expect(
      tree.root.findByProps({ accessibilityLabel: "Send Prompt" }),
    ).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: "Abort" })).toBeTruthy();
    expect(() =>
      tree.root.findByProps({
        accessibilityLabel: "Open Terminal to interact",
      }),
    ).toThrow();
    act(() => tree.unmount());
  });

  it("recovers and resyncs visible screen after transient history failure on cursor expiry", async () => {
    mockCapabilities = [
      { name: "chat", enabled: true },
      { name: "prompt", enabled: true },
      { name: "abort", enabled: true },
    ];
    mockAgentHistory.mockResolvedValueOnce({ cursor: 0, events: [] });
    const tree = await renderScreen();

    expect(mockHandleCursorExpired).toBeDefined();

    mockAgentHistory
      .mockRejectedValueOnce(new Error("transient history failure"))
      .mockResolvedValueOnce({
        cursor: 13,
        events: [
          {
            eventId: "evt-rec-1",
            agentId: "agent-1",
            type: "message.assistant",
            text: "Resynced after transient error",
            state: "idle",
            cursor: 12,
          },
          {
            eventId: "evt-rec-activity",
            agentId: "agent-1",
            type: "activity.tool.completed",
            toolName: "bash",
            cursor: 13,
          },
        ],
      });

    jest.useFakeTimers();
    let cursorPromise: Promise<number> | undefined;
    act(() => {
      cursorPromise = mockHandleCursorExpired!();
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });

    const cursor = await cursorPromise!;
    expect(cursor).toBe(13);
    expect(mockAgentHistory).toHaveBeenCalledTimes(3);

    expect(
      tree.root.findAll(
        (node) => node.props?.children === "Resynced after transient error",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      tree.root.findAll((node) => node.props?.children === "bash completed")
        .length,
    ).toBeGreaterThan(0);
    expect(mockDispatch).toHaveBeenCalledWith(expect.any(Function));

    act(() => tree.unmount());
    jest.useRealTimers();
  });
  it("renders needsYou banner when state is needsYou and switches to terminal on CTA tap", async () => {
    mockTab.state = "needsYou";
    const tree = await renderScreen();

    const banner = tree.root.findByProps({
      accessibilityLabel: "Needs Approval Banner",
    });
    expect(banner).toBeTruthy();

    const openTerminalBtn = tree.root.findByProps({
      accessibilityLabel: "Open Terminal",
    });
    expect(openTerminalBtn).toBeTruthy();

    await act(async () => {
      openTerminalBtn.props.onPress();
    });

    expect(
      tree.root.findByProps({ accessibilityLabel: "Terminal View" }),
    ).toBeTruthy();
    act(() => tree.unmount());
    mockTab.state = "working";
  });

  it("opens Files tab with agent workspace relative cwd on header action", async () => {
    mockTab.cwd = "src/components";
    const tree = await renderScreen();

    await act(async () => {
      tree.root
        .findByProps({ accessibilityLabel: "More actions" })
        .props.onPress();
    });

    const openFilesBtn = tree.root.findByProps({
      accessibilityLabel: "Open Files",
    });
    expect(openFilesBtn).toBeTruthy();

    await act(async () => {
      openFilesBtn.props.onPress();
    });

    const { addTab } = require("./lib/tabs/tab-store");
    const { router } = require("expo-router");

    expect(addTab).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "files",
        daemonId: mockTab.daemonId,
        cwd: "src/components",
      }),
    );
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/files/[id]",
      params: { id: "generated-tab" },
    });
    act(() => tree.unmount());
  });
});

describe("AgentScreen termination confirmation", () => {
  it("requires an explicit confirmation before terminating the agent", async () => {
    const tree = await renderScreen();

    await act(async () => {
      tree.root
        .findByProps({ accessibilityLabel: "More actions" })
        .props.onPress();
    });
    await act(async () => {
      tree.root
        .findByProps({ accessibilityLabel: "Terminate Agent" })
        .props.onPress();
    });
    expect(
      tree.root.findByProps({
        accessibilityLabel: "Terminate Agent Confirmation",
      }),
    ).toBeTruthy();
    expect(mockTerminateAgent).not.toHaveBeenCalled();

    await act(async () => {
      tree.root
        .findByProps({ accessibilityLabel: "Confirm Terminate Agent" })
        .props.onPress();
    });
    expect(mockTerminateAgent).toHaveBeenCalledWith("agent-1");
    act(() => tree.unmount());
  });
});

describe("Agent header overflow at narrow Android widths", () => {
  it("keeps only Back, status, view switcher, and a single overflow trigger inline, moving secondary actions behind the menu", async () => {
    const tree = await renderScreen();

    expect(tree.root.findByProps({ accessibilityLabel: "Back" })).toBeTruthy();
    expect(
      tree.root.findByProps({ accessibilityLabel: "Chat View" }),
    ).toBeTruthy();
    expect(
      tree.root.findByProps({ accessibilityLabel: "Terminal View" }),
    ).toBeTruthy();
    expect(
      tree.root.findByProps({ accessibilityLabel: "More actions" }),
    ).toBeTruthy();

    for (const label of [
      "Switch pane",
      "Model and Thinking",
      "Open Files",
      "Terminate Agent",
      "Close View",
    ]) {
      expect(() =>
        tree.root.findByProps({ accessibilityLabel: label }),
      ).toThrow();
    }

    await act(async () => {
      tree.root
        .findByProps({ accessibilityLabel: "More actions" })
        .props.onPress();
    });

    expect(
      tree.root.findByProps({ accessibilityLabel: "Switch pane" }),
    ).toBeTruthy();
    expect(
      tree.root.findByProps({ accessibilityLabel: "Open Files" }),
    ).toBeTruthy();
    expect(
      tree.root.findByProps({ accessibilityLabel: "Terminate Agent" }),
    ).toBeTruthy();
    expect(
      tree.root.findByProps({ accessibilityLabel: "Close View" }),
    ).toBeTruthy();
    act(() => tree.unmount());
  });

  it.each<{
    state: AgentWorkspaceTab["state"];
    capabilities: AgentCapability[];
    menuAction: string;
  }>([
    {
      state: "working",
      capabilities: [{ name: "abort", enabled: true }],
      menuAction: "Abort",
    },
    { state: "needsYou", capabilities: [], menuAction: "Open Files" },
    {
      state: "idle",
      capabilities: [{ name: "model", enabled: true }],
      menuAction: "Model and Thinking",
    },
  ])(
    "keeps title/status usable and secondary actions in overflow at 320dp for $state",
    async ({ state, capabilities, menuAction }) => {
      require("react-native").__setWindowDimensions({
        width: 320,
        height: 640,
      });
      mockTab.state = state;
      mockCapabilities = capabilities;
      const tree = await renderScreen();

      expect(
        tree.root.findByProps({ accessibilityLabel: "Agent title and status" }),
      ).toBeTruthy();
      expect(
        tree.root.findByProps({ accessibilityLabel: "Back" }),
      ).toBeTruthy();
      expect(
        tree.root.findByProps({ accessibilityLabel: "Chat View" }),
      ).toBeTruthy();
      expect(
        tree.root.findByProps({ accessibilityLabel: "Terminal View" }),
      ).toBeTruthy();
      expect(() =>
        tree.root.findByProps({ accessibilityLabel: "Abort" }),
      ).toThrow();

      await act(async () => {
        tree.root
          .findByProps({ accessibilityLabel: "More actions" })
          .props.onPress();
      });
      expect(
        tree.root.findByProps({ accessibilityLabel: menuAction }),
      ).toBeTruthy();
      act(() => tree.unmount());
    },
  );
});

describe("embedded Agent terminal transport errors", () => {
  it("shows transport errors and inactivates an exited terminal session", async () => {
    const tree = await renderScreen();
    await act(async () => {
      tree.root
        .findByProps({ accessibilityLabel: "Terminal View" })
        .props.onPress();
      mockPTYHandler?.({
        type: "error",
        code: "session_not_running",
        message: "Terminal is no longer running",
      });
    });
    expect(
      tree.root
        .findByProps({ accessibilityLabel: "Terminal transport error" })
        .findByType("Text" as never).props.children,
    ).toBe("Terminal is no longer running");

    await act(async () => {
      mockPTYHandler?.({ type: "session.state", state: "exited" });
    });
    expect(
      tree.root
        .findByProps({ accessibilityLabel: "Terminal transport error" })
        .findByType("Text" as never).props.children,
    ).toBe("Terminal session ended");
    expect(mockDispatch).toHaveBeenCalledWith(expect.any(Function));
    expect(() =>
      tree.root.findByType(
        require("./components/ShortcutKeyboard").ShortcutKeyboard,
      ),
    ).toThrow();
  });
});

describe("A06 – Android chat composer IME avoidance", () => {
  it("adds the measured Android keyboard inset to the chat container and clears it when hidden", async () => {
    const { Platform } = require("react-native");
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, "OS", { value: "android" });
    try {
      const tree = await renderScreen();
      await act(async () => {
        mockKeyboardListeners.get("keyboardDidShow")?.({
          endCoordinates: { screenY: 600 },
        });
      });
      expect(
        tree.root.findByType("KeyboardAvoidingView" as never).props.style,
      ).toEqual(expect.arrayContaining([{ paddingBottom: 244 }]));
      await act(async () => {
        mockKeyboardListeners.get("keyboardDidHide")?.({
          endCoordinates: { screenY: 844 },
        });
      });
      expect(
        tree.root.findByType("KeyboardAvoidingView" as never).props.style,
      ).not.toEqual(
        expect.arrayContaining([{ paddingBottom: expect.any(Number) }]),
      );
      act(() => tree.unmount());
    } finally {
      Object.defineProperty(Platform, "OS", { value: originalOS });
    }
  });
});

describe("A05 – durable activity event rendering", () => {
  it("renders activity.turn.started as distinct activity row, not user/assistant bubble", async () => {
    mockAgentHistory.mockResolvedValue({
      cursor: 1,
      events: [
        {
          eventId: "act-1",
          agentId: "agent-1",
          type: "activity.turn.started",
          cursor: 1,
        },
      ],
    });
    const tree = await renderScreen();
    expect(
      tree.root.findAll((node) => node.props?.children === "Turn started")
        .length,
    ).toBeGreaterThan(0);
    expect(() =>
      tree.root.findByProps({ accessibilityLabel: "User" }),
    ).toThrow();
    act(() => tree.unmount());
  });

  it("renders live activity.tool.started via event stream with tool name", async () => {
    const tree = await renderScreen();
    await act(async () => {
      mockHandleEvent?.({
        type: "activity.tool.started",
        eventId: "act-2",
        agentId: "agent-1",
        toolName: "bash",
      });
    });
    expect(
      tree.root.findAll((node) => node.props?.children === "Running bash")
        .length,
    ).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it.each([
    ["activity.tool.completed", { toolName: "bash" }, "bash completed"],
    ["activity.tool.failed", { toolName: "bash" }, "bash failed"],
    ["activity.approval.requested", {}, "Approval requested"],
    ["activity.approval.resolved", {}, "Approval resolved"],
  ])("renders %s as a labelled activity row", async (type, detail, label) => {
    mockAgentHistory.mockResolvedValue({
      cursor: 1,
      events: [
        {
          eventId: `activity-${type}`,
          agentId: "agent-1",
          type,
          ...detail,
          cursor: 1,
        } as AgentEvent,
      ],
    });
    const tree = await renderScreen();
    expect(
      tree.root.findAll((node) => node.props?.children === label).length,
    ).toBeGreaterThan(0);
    expect(() =>
      tree.root.findByProps({ accessibilityLabel: "User" }),
    ).toThrow();
    act(() => tree.unmount());
  });

  it("skips system/hook messages: events with no id are not rendered", async () => {
    const tree = await renderScreen();
    await act(async () => {
      mockHandleEvent?.({
        type: "system",
        agentId: "agent-1",
        text: "internal hook data",
      } as unknown as AgentEvent);
    });
    expect(
      tree.root.findAll((node) => node.props?.children === "internal hook data")
        .length,
    ).toBe(0);
    act(() => tree.unmount());
  });
});

describe("A07 – tool payload expand/collapse", () => {
  it("renders tool.call with collapse toggle and full text on press", async () => {
    mockAgentHistory.mockResolvedValue({
      cursor: 1,
      events: [
        {
          eventId: "tool-1",
          agentId: "agent-1",
          type: "tool.call",
          toolName: "bash",
          toolInput: { cmd: "ls" },
          cursor: 1,
        },
      ],
    });
    const tree = await renderScreen();
    expect(
      tree.root.findAll((node) => node.props?.children === "Show more").length,
    ).toBeGreaterThan(0);
    const toggle = tree.root.findByProps({
      accessibilityLabel: "Toggle bash input",
    });
    await act(async () => {
      toggle.props.onPress();
    });
    expect(
      tree.root.findAll((node) => node.props?.children === "Show less").length,
    ).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it("renders tool.result with collapse toggle and full text on press", async () => {
    mockAgentHistory.mockResolvedValue({
      cursor: 1,
      events: [
        {
          eventId: "tool-2",
          agentId: "agent-1",
          type: "tool.result",
          toolName: "bash",
          text: "file.txt",
          cursor: 1,
        },
      ],
    });
    const tree = await renderScreen();
    expect(
      tree.root.findAll((node) => node.props?.children === "Show more").length,
    ).toBeGreaterThan(0);
    const toggle = tree.root.findByProps({
      accessibilityLabel: "Toggle bash output",
    });
    await act(async () => {
      toggle.props.onPress();
    });
    expect(
      tree.root.findAll((node) => node.props?.children === "Show less").length,
    ).toBeGreaterThan(0);
    act(() => tree.unmount());
  });
});

describe("A10 – internal content never reaches chat", () => {
  it("rejects a message.system sentinel: internal/hook provenance must never render even under a hypothetical backend regression", async () => {
    const tree = await renderScreen();
    await act(async () => {
      mockHandleEvent?.({
        type: "message.system",
        eventId: "sentinel-1",
        agentId: "agent-1",
        text: "INTERNAL_SYSTEM_SENTINEL_DO_NOT_RENDER",
      } as unknown as AgentEvent);
    });
    expect(
      tree.root.findAll(
        (node) =>
          typeof node.props?.children === "string" &&
          node.props.children.includes(
            "INTERNAL_SYSTEM_SENTINEL_DO_NOT_RENDER",
          ),
      ).length,
    ).toBe(0);
    act(() => tree.unmount());
  });

  it("rejects any unrecognized event type carrying text: the renderer is an allowlist, not a wildcard fallback", async () => {
    const tree = await renderScreen();
    await act(async () => {
      mockHandleEvent?.({
        type: "custom_message",
        eventId: "unknown-1",
        agentId: "agent-1",
        text: "unexpected internal payload",
      } as unknown as AgentEvent);
    });
    expect(
      tree.root.findAll(
        (node) =>
          typeof node.props?.children === "string" &&
          node.props.children.includes("unexpected internal payload"),
      ).length,
    ).toBe(0);
    act(() => tree.unmount());
  });

  it("still renders an allowlisted message.fileMention as chat-visible content (positive control)", async () => {
    const tree = await renderScreen();
    await act(async () => {
      mockHandleEvent?.({
        type: "message.fileMention",
        eventId: "file-1",
        agentId: "agent-1",
        text: "README.md",
      } as unknown as AgentEvent);
    });
    expect(
      tree.root.findAll((node) => node.props?.children === "README.md").length,
    ).toBeGreaterThan(0);
    act(() => tree.unmount());
  });
});

describe("A04 – five-turn chat history/live/resync replay", () => {
  it("preserves every distinct sentinel exactly once and in order across history bootstrap, live delivery, and a forced resync", async () => {
    // Turns 1-2 arrive via the initial history bootstrap cursor.
    mockAgentHistory.mockResolvedValueOnce({
      cursor: 2,
      events: [
        {
          eventId: "user-1",
          agentId: "agent-1",
          type: "message.user",
          text: "turn-1-user",
          cursor: 1,
        },
        {
          eventId: "asst-1",
          agentId: "agent-1",
          type: "message.assistant",
          text: "turn-1-assistant",
          cursor: 1,
        },
        {
          eventId: "user-2",
          agentId: "agent-1",
          type: "message.user",
          text: "turn-2-user",
          cursor: 2,
        },
        {
          eventId: "asst-2",
          agentId: "agent-1",
          type: "message.assistant",
          text: "turn-2-assistant",
          cursor: 2,
        },
      ],
    });
    const tree = await renderScreen();
    expect(mockHandleEvent).toBeDefined();
    expect(mockHandleCursorExpired).toBeDefined();

    // Turns 3-4 arrive live over the open runtime channel.
    await act(async () => {
      mockHandleEvent?.({
        eventId: "user-3",
        agentId: "agent-1",
        type: "message.user",
        text: "turn-3-user",
        cursor: 3,
      });
      mockHandleEvent?.({
        eventId: "asst-3",
        agentId: "agent-1",
        type: "message.assistant",
        text: "turn-3-assistant",
        cursor: 3,
      });
      mockHandleEvent?.({
        eventId: "user-4",
        agentId: "agent-1",
        type: "message.user",
        text: "turn-4-user",
        cursor: 4,
      });
      mockHandleEvent?.({
        eventId: "asst-4",
        agentId: "agent-1",
        type: "message.assistant",
        text: "turn-4-assistant",
        cursor: 4,
      });
    });

    // Before turn 5, force the existing resync path (cursor-expired reload),
    // which must replay turns 1-4 plus the new turn-5 pair without loss,
    // duplication, or reordering, and without starting a second OMP process
    // or agent/terminal identity.
    mockAgentHistory.mockResolvedValueOnce({
      cursor: 5,
      events: [
        {
          eventId: "user-1",
          agentId: "agent-1",
          type: "message.user",
          text: "turn-1-user",
          cursor: 1,
        },
        {
          eventId: "asst-1",
          agentId: "agent-1",
          type: "message.assistant",
          text: "turn-1-assistant",
          cursor: 1,
        },
        {
          eventId: "user-2",
          agentId: "agent-1",
          type: "message.user",
          text: "turn-2-user",
          cursor: 2,
        },
        {
          eventId: "asst-2",
          agentId: "agent-1",
          type: "message.assistant",
          text: "turn-2-assistant",
          cursor: 2,
        },
        {
          eventId: "user-3",
          agentId: "agent-1",
          type: "message.user",
          text: "turn-3-user",
          cursor: 3,
        },
        {
          eventId: "asst-3",
          agentId: "agent-1",
          type: "message.assistant",
          text: "turn-3-assistant",
          cursor: 3,
        },
        {
          eventId: "user-4",
          agentId: "agent-1",
          type: "message.user",
          text: "turn-4-user",
          cursor: 4,
        },
        {
          eventId: "asst-4",
          agentId: "agent-1",
          type: "message.assistant",
          text: "turn-4-assistant",
          cursor: 4,
        },
        {
          eventId: "user-5",
          agentId: "agent-1",
          type: "message.user",
          text: "turn-5-user",
          cursor: 5,
        },
        {
          eventId: "asst-5",
          agentId: "agent-1",
          type: "message.assistant",
          text: "turn-5-assistant",
          cursor: 5,
        },
      ],
    });

    let resyncCursor: number | undefined;
    await act(async () => {
      resyncCursor = await mockHandleCursorExpired!();
    });
    expect(resyncCursor).toBe(5);

    // Turn 5 delivered live after the resync completes.
    await act(async () => {
      mockHandleEvent?.({
        eventId: "user-5",
        agentId: "agent-1",
        type: "message.user",
        text: "turn-5-user",
        cursor: 5,
      });
      mockHandleEvent?.({
        eventId: "asst-5",
        agentId: "agent-1",
        type: "message.assistant",
        text: "turn-5-assistant",
        cursor: 5,
      });
    });

    const expectedTexts = [1, 2, 3, 4, 5].flatMap((n) => [
      `turn-${n}-user`,
      `turn-${n}-assistant`,
    ]);
    for (const text of expectedTexts) {
      expect(
        tree.root.findAll(
          (node) =>
            node.type === ("Text" as never) && node.props?.children === text,
        ).length,
      ).toBe(1);
    }

    act(() => tree.unmount());
  });
});
