import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, TextInput } from 'react-native';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
}));

import { NewAgentSheet } from './NewAgentSheet';

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
      expect.stringContaining('relative')
    );
  });

  it('cancels when cancel button is clicked', async () => {
    const onSubmit = jest.fn();
    const onDismiss = jest.fn();
    let tree: ReactTestRenderer | undefined;

    await act(async () => {
      tree = create(<NewAgentSheet visible onDismiss={onDismiss} onSubmit={onSubmit} />);
    });

    const cancelBtn = tree!.root.findByProps({ accessibilityLabel: 'Cancel' });
    await act(async () => {
      cancelBtn.props.onPress();
    });

    expect(onDismiss).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
