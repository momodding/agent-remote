import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, TextInput } from 'react-native';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
}));
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));

import { NewAgentSheet } from './NewAgentSheet';
import type { AgenticRemoteAPI } from '../lib/api';
import type { FileEntry } from '../protocol';

describe('NewAgentSheet', () => {
  beforeEach(() => {
    jest.spyOn(Alert, 'alert');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('submits with default empty cwd and auto backend', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const onDismiss = jest.fn();
    let tree: ReactTestRenderer | undefined;

    await act(async () => {
      tree = create(<NewAgentSheet visible onDismiss={onDismiss} onSubmit={onSubmit} />);
    });

    const submitBtn = tree!.root.findByProps({ accessibilityLabel: 'Create Agent' });
    await act(async () => {
      submitBtn.props.onPress();
    });

    expect(onSubmit).toHaveBeenCalledWith({ cwd: '', backend: 'auto' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('submits with custom workspace cwd and selected backend', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const onDismiss = jest.fn();
    let tree: ReactTestRenderer | undefined;

    await act(async () => {
      tree = create(<NewAgentSheet visible onDismiss={onDismiss} onSubmit={onSubmit} />);
    });

    // Enter custom cwd
    const input = tree!.root.findByProps({ accessibilityLabel: 'Workspace Path' });
    await act(async () => {
      input.props.onChangeText('backend/internal');
    });

    // Select tmux backend
    const tmuxOption = tree!.root.findByProps({ accessibilityLabel: 'Backend tmux' });
    await act(async () => {
      tmuxOption.props.onPress();
    });

    const submitBtn = tree!.root.findByProps({ accessibilityLabel: 'Create Agent' });
    await act(async () => {
      submitBtn.props.onPress();
    });

    expect(onSubmit).toHaveBeenCalledWith({ cwd: 'backend/internal', backend: 'tmux' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('browses directories using api and selects directory', async () => {
    const rootEntries: FileEntry[] = [
      { name: 'src', path: 'src', isDir: true, size: 0, mode: 'drwxr-xr-x' },
      { name: 'backend', path: 'backend', isDir: true, size: 0, mode: 'drwxr-xr-x' },
      { name: 'README.md', path: 'README.md', isDir: false, size: 100, mode: '-rw-r--r--' },
    ];
    const srcEntries: FileEntry[] = [
      { name: 'components', path: 'src/components', isDir: true, size: 0, mode: 'drwxr-xr-x' },
      { name: 'index.ts', path: 'src/index.ts', isDir: false, size: 50, mode: '-rw-r--r--' },
    ];

    const mockApi = {
      files: jest.fn().mockImplementation(async (path: string) => {
        if (path === '') return rootEntries;
        if (path === 'src') return srcEntries;
        return [];
      }),
    } as unknown as AgenticRemoteAPI;

    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const onDismiss = jest.fn();
    let tree: ReactTestRenderer | undefined;

    await act(async () => {
      tree = create(<NewAgentSheet visible onDismiss={onDismiss} onSubmit={onSubmit} api={mockApi} />);
    });

    expect(mockApi.files).toHaveBeenCalledWith('');

    // Directory list should show 'src' and 'backend', but not README.md
    const srcDirBtn = tree!.root.findByProps({ accessibilityLabel: 'Directory src' });
    expect(srcDirBtn).toBeTruthy();

    // Navigate into 'src'
    await act(async () => {
      srcDirBtn.props.onPress();
    });

    expect(mockApi.files).toHaveBeenCalledWith('src');

    // Inside 'src', should show 'components'
    const compDirBtn = tree!.root.findByProps({ accessibilityLabel: 'Directory components' });
    expect(compDirBtn).toBeTruthy();

    // Up button should be available
    const upBtn = tree!.root.findByProps({ accessibilityLabel: 'Navigate up' });
    expect(upBtn).toBeTruthy();

    // Navigate up back to root
    await act(async () => {
      upBtn.props.onPress();
    });

    expect(mockApi.files).toHaveBeenCalledWith('');

    // Select workspace root explicitly
    const selectRootBtn = tree!.root.findByProps({ accessibilityLabel: 'Select Current Directory' });
    await act(async () => {
      selectRootBtn.props.onPress();
    });

    // Submit
    const submitBtn = tree!.root.findByProps({ accessibilityLabel: 'Create Agent' });
    await act(async () => {
      submitBtn.props.onPress();
    });

    expect(onSubmit).toHaveBeenCalledWith({ cwd: '', backend: 'auto' });
  });

  it('rejects absolute paths with client-side validation', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const onDismiss = jest.fn();
    let tree: ReactTestRenderer | undefined;

    await act(async () => {
      tree = create(<NewAgentSheet visible onDismiss={onDismiss} onSubmit={onSubmit} />);
    });

    const input = tree!.root.findByProps({ accessibilityLabel: 'Workspace Path' });
    await act(async () => {
      input.props.onChangeText('/etc/passwd');
    });

    const submitBtn = tree!.root.findByProps({ accessibilityLabel: 'Create Agent' });
    await act(async () => {
      submitBtn.props.onPress();
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Invalid Workspace Path',
      expect.stringContaining('relative')
    );
  });

  it('rejects path traversal with ..', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const onDismiss = jest.fn();
    let tree: ReactTestRenderer | undefined;

    await act(async () => {
      tree = create(<NewAgentSheet visible onDismiss={onDismiss} onSubmit={onSubmit} />);
    });

    const input = tree!.root.findByProps({ accessibilityLabel: 'Workspace Path' });
    await act(async () => {
      input.props.onChangeText('../parent');
    });

    const submitBtn = tree!.root.findByProps({ accessibilityLabel: 'Create Agent' });
    await act(async () => {
      submitBtn.props.onPress();
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Invalid Workspace Path',
      expect.stringContaining("..")
    );
  });
});
