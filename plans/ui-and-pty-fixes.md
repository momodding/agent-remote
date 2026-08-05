# agenticRemote Fixes and Refinements Plan
<!-- source-branch: main -->
<!-- work-branch: omp/ui-and-pty-fixes -->

## Context
Resolve four issues in the agenticRemote client and daemon:
1. **Keyboard UI:** Implement a toggle on the toolbar (or equivalent location) so the custom `ShortcutKeyboard` and the native mobile keyboard are mutually exclusive, sliding in without jumping the layout.
2. **Shell Spawn:** Stop hardcoding `bash` for session creation in the backend (`manager.go`) and frontend (`AddSessionFAB.tsx`), properly reading user environment defaults (`$SHELL`, `COMSPEC`).
3. **Keyboard Occlusion:** Wrap `ConnectionSheet`, `PairingSheet`, and `AddSessionFAB` internals with `KeyboardAvoidingView` so text inputs are accessible when the mobile keyboard opens.
4. **Broadcast Duplication:** Fix the N² multi-broadcast bug where keystrokes are duplicated because two nested layers loop over the same active sessions.

## Approach

### 1. Fix Broadcast Input Duplication (N² bug)
Currently, `client/app/terminal/[id].tsx` intercepts broadcast input and loops it to all sessions. Then it also passes its single-session `input` callback down to `MultiTerminal`. `MultiTerminal.tsx` additionally contains its own `if (isBroadcasting) { visibleSessions.forEach(...) }` fan-out loop, resulting in a squared duplication.
- Remove the fan-out loop inside `client/src/components/MultiTerminal.tsx` entirely. At line ~40, change `handleInput` to simply call `onInput(sessionId, data)` unconditionally. Let the screen container (`[id].tsx`) be the sole owner of the broadcast fan-out logic.

### 2. Native Default Shell Instantiation
- **Backend:** In `backend/internal/session/manager.go`, the fallback logic when `command` is empty correctly calls `defaultShell()`. However, `defaultShell()` only checks `COMSPEC` or `SHELL`. It needs to parse `/etc/passwd` on Unix as a definitive fallback layer when `SHELL` is missing.
    - Update `defaultShell()` in `backend/internal/session/manager.go` to use `os/user` to lookup the current user and their `HomeDir`/shell (if castable to `strings.HasSuffix`), or simply use `user.Current()` for fallback, defaulting to `/bin/sh` or `/bin/bash` only if that fails.
- **Frontend Override:** The `client/src/components/AddSessionFAB.tsx` explicitly hardcodes `bash` in its state initialization (`const [command, setCommand] = useState('bash');`).
    - Change this to an empty string (`useState('')`) and pass the empty string in the `api.createSession` payload, allowing the backend's `defaultShell()` logic to do the heavy lifting automatically. Update the placeholder to say `"e.g. bash, zsh (leave empty for default)"`.

### 3. Keyboard Occlusion on Modals
The three modals (`PairingSheet`, `ConnectionSheet`, `AddSessionFAB`) use standard React Native `<Modal>` but fail to wrap their scrolling inputs with `<KeyboardAvoidingView>`. Because they exist inside modals at the root stack level, they bypass the app layout's avoidance.
- **`AddSessionFAB.tsx`**: Add `KeyboardAvoidingView` wrapper with `behavior={Platform.OS === 'ios' ? 'padding' : 'height'}` immediately inside the `<Modal>` wrapping the inner content.
- **`ConnectionSheet.tsx`**: Add `KeyboardAvoidingView` around the `<ScrollView>` inside the `Editor` component.
- **`PairingSheet.tsx`**: Add `KeyboardAvoidingView` with the same behavior styling around the interior `<View style={styles.sheet}>`. 

### 4. In-Place Keyboard Swapping (UI Refinement)
The terminal currently shows `ShortcutKeyboard` permanently above the soft keyboard. 
- In `client/src/components/ShortcutKeyboard.tsx`, rewrite state to treat the Shortcut keypad and the Native keypad as mutually exclusive overlays.
- A new button is added to the `MultiTerminal.tsx` toolbar or the terminal `ShortcutKeyboard` itself: `⌨️`.
- When custom shortcuts are shown, `Terminal.tsx` `blur()` is called (to drop native keyboard) and the custom keypad renders at standard keyboard height. 
- When native keyboard is active (listening to `Keyboard.addListener`), automatically collapse the custom `ShortcutKeyboard` to just the toggle row.
- Add a direct prop `onToggleHardware` to flip focus back to the WebView when transitioning from custom-keys to native typing.

## Critical files & anchors
- `client/src/components/MultiTerminal.tsx`: The `handleInput` at line 40 must be changed from a broadcast loop to a 1:1 map.
- `client/app/terminal/[id].tsx`: Remains the source of truth for broadcast fan-out at line 188.
- `backend/internal/session/manager.go`: `defaultShell()` around line 465 needs `os/user` augmentation.
- `client/src/components/AddSessionFAB.tsx`: Remove `bash` hardcode on line 16, add KeyboardAvoidingView in the render block. 

## Verification
1. **Broadcast**: Open two panes. Enable Broadcast. Type a single character. Verify exactly one character appears in both panes, not two.
2. **Shell Start**: Empty the Command box in Add Session. Create. Verify `echo $0` corresponds to `$SHELL` (like `/bin/zsh`) rather than `/bin/bash` or `bash`.
3. **Occlusion Fix**: Launch on iOS simulator. Click Add Session. Focus the "Command" input. Ensure the entire form shifts up above the native keyboard.
4. **Keyboard UI**: Tap the custom toolbar button. Verify the OS keyboard hides and the custom grid appears. Tap terminal to type; verify the OS keyboard pushes up and the custom grid collapses down to the single toolbar automatically.

## Assumptions & contingencies
- Assumption: The UI expects `KeyboardAvoidingView` to use `padding` on iOS and `height` on Android, mirroring `[id].tsx`.
- Fallback: If `user.Current()` fails on cross-compiled platforms in `manager.go`, it will gracefully fall through to `/bin/sh` or `cmd.exe` as it currently does.