package harness

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type driverFunc func(context.Context, Input) error

func (f driverFunc) Drive(ctx context.Context, input Input) error { return f(ctx, input) }

func TestInputArbiterSerializesDriverCalls(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var mu sync.Mutex
	active := 0
	maxActive := 0
	var order []string
	driver := driverFunc(func(_ context.Context, input Input) error {
		mu.Lock()
		active++
		if active > maxActive {
			maxActive = active
		}
		order = append(order, string(input.Bytes))
		mu.Unlock()
		if string(input.Bytes) == "first" {
			close(started)
			<-release
		}
		mu.Lock()
		active--
		mu.Unlock()
		return nil
	})
	arbiter := NewInputArbiter(driver)
	defer arbiter.Close()

	first := make(chan error, 1)
	second := make(chan error, 1)
	third := make(chan error, 1)
	go func() { first <- arbiter.Submit(context.Background(), Input{Bytes: []byte("first")}) }()
	<-started
	go func() { second <- arbiter.Submit(context.Background(), Input{Bytes: []byte("second")}) }()
	deadline := time.Now().Add(time.Second)
	for len(arbiter.queue) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("second input was not queued")
		}
		time.Sleep(time.Millisecond)
	}
	go func() { third <- arbiter.Submit(context.Background(), Input{Bytes: []byte("third")}) }()
	for len(arbiter.queue) != 2 {
		if time.Now().After(deadline) {
			t.Fatal("third input was not queued")
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	for _, result := range []<-chan error{first, second, third} {
		if err := <-result; err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if maxActive != 1 {
		t.Fatalf("concurrent driver calls = %d, want 1", maxActive)
	}
	if got, want := order, []string{"first", "second", "third"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("write order = %v, want %v", got, want)
	}
}

func TestRouterRoutesOnlyEnabledExplicitAction(t *testing.T) {
	var got Input
	adapter := NewOMPAdapter(driverFunc(func(_ context.Context, input Input) error {
		got = input
		return nil
	}))
	defer adapter.Close()

	input := Input{Capability: CapabilityTUIInput, Action: ActionTUIInput, Bytes: []byte("hello")}
	if err := adapter.Router.Route(context.Background(), input); err != nil {
		t.Fatalf("route input: %v", err)
	}
	if string(got.Bytes) != "hello" {
		t.Fatalf("driver input = %q", got.Bytes)
	}
	if err := adapter.Router.Route(context.Background(), Input{Capability: CapabilityOMPPrompt, Action: ActionOMPPrompt}); !errors.Is(err, ErrRouteDisabled) {
		t.Fatalf("disabled semantic route error = %v, want %v", err, ErrRouteDisabled)
	}
	if err := adapter.Router.Route(context.Background(), Input{Capability: CapabilityTUIInput, Action: ActionOMPPrompt}); !errors.Is(err, ErrRouteUnknown) {
		t.Fatalf("mismatched route error = %v, want %v", err, ErrRouteUnknown)
	}
}

func TestInputArbiterRejectsClosedInput(t *testing.T) {
	arbiter := NewInputArbiter(driverFunc(func(context.Context, Input) error { return nil }))
	arbiter.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := arbiter.Submit(ctx, Input{}); !errors.Is(err, ErrInputClosed) {
		t.Fatalf("closed submit error = %v, want %v", err, ErrInputClosed)
	}
}

func TestAdapterSerializesInputSources(t *testing.T) {
	var got []HarnessInputSource
	adapter := NewOMPAdapter(driverFunc(func(_ context.Context, input Input) error {
		got = append(got, input.Source)
		return nil
	}))
	defer adapter.Close()
	for _, source := range []HarnessInputSource{SourceTerminalUser, SourceChatPrompt, SourceSystemControl} {
		if err := adapter.Router.Route(context.Background(), Input{Capability: CapabilityTUIInput, Action: ActionTUIInput, Source: source}); err != nil {
			t.Fatal(err)
		}
	}
	if want := []HarnessInputSource{SourceTerminalUser, SourceChatPrompt, SourceSystemControl}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("sources = %v, want %v", got, want)
	}
}

func TestAdapterObserverPreservesProvenance(t *testing.T) {
	adapter := NewOMPAdapter(driverFunc(func(context.Context, Input) error { return nil }))
	defer adapter.Close()
	observed := make(chan Observation, 1)
	adapter.AddObserver(ObserverFunc(func(observation Observation) { observed <- observation }))
	want := Observation{Provenance: Provenance{Source: "tui", SessionID: "agent-1", ProcessID: "term-1"}, Lifecycle: LifecycleReady, Bytes: []byte("output")}
	adapter.Observe(want)
	got := <-observed
	if got.Provenance != want.Provenance || got.Lifecycle != want.Lifecycle || string(got.Bytes) != string(want.Bytes) {
		t.Fatalf("observation = %#v, want %#v", got, want)
	}
}

func TestDescriptorReportsActualRouteState(t *testing.T) {
	adapter := NewOMPAdapter(driverFunc(func(context.Context, Input) error { return nil }))
	defer adapter.Close()
	descriptor := adapter.Descriptor()
	if descriptor.ID != "omp" || descriptor.DisplayName != "OMP" || descriptor.Version != "" {
		t.Fatalf("descriptor identity = %#v", descriptor)
	}
	routes := make(map[HarnessCapability]HarnessActionRoute)
	for _, route := range descriptor.Routes {
		routes[route.Capability] = route
	}
	if tui := routes[CapabilityTUIInput]; tui.Transport != TransportTUI || tui.Authority != AuthorityAuthoritative || !tui.Availability || tui.Reason != "" {
		t.Fatalf("TUI route = %#v", tui)
	}
	if prompt := routes[CapabilityPrompt]; prompt.Transport != TransportUnsupported || prompt.Authority != AuthorityObserved || prompt.Availability || prompt.Reason == "" {
		t.Fatalf("prompt route = %#v", prompt)
	}
	if !descriptor.Runtime.FeatureStates[CapabilityTUIInput] || descriptor.Runtime.FeatureStates[CapabilityPrompt] {
		t.Fatalf("feature states = %#v", descriptor.Runtime.FeatureStates)
	}
}

func TestOMPGoalShowDriverRejectsNonReadyStates(t *testing.T) {
	var writes int
	adapter := NewOMPAdapterWithVersion(OMPVersion1861, driverFunc(func(context.Context, Input) error {
		writes++
		return nil
	}))
	defer adapter.Close()
	input := Input{Capability: CapabilityOMPGoal, Action: ActionOMPGoalShow, Bytes: []byte(ompGoalShow)}
	for _, tc := range []struct {
		name  string
		state OmpTuiState
		want  error
	}{
		{"unknown", OmpTuiUnknown, ErrTUIStateUnknown},
		{"busy", OmpTuiBusy, ErrTUIStateBusy},
		{"approval", OmpTuiApproval, ErrTUIStateApproval},
		{"modal", OmpTuiModal, ErrTUIStateModal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			adapter.goalDriver.Observe(Observation{InteractionState: string(tc.state)})
			if err := adapter.Router.Route(context.Background(), input); !errors.Is(err, tc.want) {
				t.Fatalf("Route error = %v, want %v", err, tc.want)
			}
		})
	}
	if writes != 0 {
		t.Fatalf("writes = %d, want 0", writes)
	}
}

func TestOMPGoalShowDriverWritesEveryCallSinceReadOnlyStatusNeverConfirms(t *testing.T) {
	var writes [][]byte
	adapter := NewOMPAdapterWithVersion(OMPVersion1861, driverFunc(func(_ context.Context, input Input) error {
		writes = append(writes, append([]byte(nil), input.Bytes...))
		return nil
	}))
	defer adapter.Close()
	adapter.Observe(Observation{Lifecycle: LifecycleReady})
	input := Input{Capability: CapabilityOMPGoal, Action: ActionOMPGoalShow, Bytes: []byte(ompGoalShow)}
	if err := adapter.Router.Route(context.Background(), input); !errors.Is(err, ErrTUIConfirmationPending) {
		t.Fatalf("first route error = %v, want pending confirmation", err)
	}
	if err := adapter.Router.Route(context.Background(), input); !errors.Is(err, ErrTUIConfirmationPending) {
		t.Fatalf("second route error = %v, want pending confirmation", err)
	}
	// `/goal show` (interactive-mode.ts #showGoalDetails) is a pure read-only
	// status print that never calls appendModeChange, so no mode_change
	// observation can ever confirm it; unlike plan_toggle, it must not be
	// latched to a single write per agent lifetime.
	if len(writes) != 2 || string(writes[0]) != ompGoalShow || string(writes[1]) != ompGoalShow {
		t.Fatalf("writes = %q, want exactly two %q", writes, ompGoalShow)
	}
}

func TestOMPGoalShowRouteIsVersionGated(t *testing.T) {
	adapter := NewOMPAdapterWithVersion("18.6.2", driverFunc(func(context.Context, Input) error { return nil }))
	defer adapter.Close()
	err := adapter.Router.Route(context.Background(), Input{Capability: CapabilityOMPGoal, Action: ActionOMPGoalShow, Bytes: []byte(ompGoalShow)})
	if !errors.Is(err, ErrRouteUnknown) {
		t.Fatalf("route error = %v, want %v", err, ErrRouteUnknown)
	}
}

func TestOmpTuiDriverRejectsUnsupportedVersion(t *testing.T) {
	driver := NewOmpTuiDriver("18.6.2", driverFunc(func(context.Context, Input) error { return nil }))
	driver.Observe(Observation{Lifecycle: LifecycleReady})
	err := driver.Drive(context.Background(), Input{Capability: CapabilityOMPGoal, Action: ActionOMPGoalShow, Bytes: []byte(ompGoalShow)})
	if !errors.Is(err, ErrRouteDisabled) {
		t.Fatalf("Drive error = %v, want %v", err, ErrRouteDisabled)
	}
}

func TestOMPGoalShowSharesTerminalInputArbiter(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var mu sync.Mutex
	active := 0
	maxActive := 0
	var order []string
	driver := driverFunc(func(_ context.Context, input Input) error {
		mu.Lock()
		active++
		if active > maxActive {
			maxActive = active
		}
		order = append(order, string(input.Bytes))
		mu.Unlock()
		if string(input.Bytes) == "terminal_user" {
			close(started)
			<-release
		}
		mu.Lock()
		active--
		mu.Unlock()
		return nil
	})
	adapter := NewOMPAdapterWithVersion(OMPVersion1861, driver)
	defer adapter.Close()
	adapter.Observe(Observation{Lifecycle: LifecycleReady})
	terminalDone := make(chan error, 1)
	go func() {
		terminalDone <- adapter.Router.Route(context.Background(), Input{
			Capability: CapabilityTUIInput, Action: ActionTUIInput, Source: SourceTerminalUser, Bytes: []byte("terminal_user"),
		})
	}()
	<-started
	goalDone := make(chan error, 1)
	go func() {
		goalDone <- adapter.Router.Route(context.Background(), Input{
			Capability: CapabilityOMPGoal, Action: ActionOMPGoalShow, Bytes: []byte(ompGoalShow),
		})
	}()
	select {
	case err := <-goalDone:
		t.Fatalf("goal completed while terminal write was held: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if err := <-terminalDone; err != nil {
		t.Fatalf("terminal route error = %v", err)
	}
	if err := <-goalDone; !errors.Is(err, ErrTUIConfirmationPending) {
		t.Fatalf("goal route error = %v, want pending confirmation", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if maxActive != 1 {
		t.Fatalf("max simultaneous driver calls = %d, want 1", maxActive)
	}
	if len(order) != 2 || order[0] != "terminal_user" || order[1] != ompGoalShow {
		t.Fatalf("write order = %q, want terminal_user then %q", order, ompGoalShow)
	}
}

func TestOMPPlanToggleSharesTerminalInputArbiter(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var mu sync.Mutex
	active, maxActive := 0, 0
	var order []string
	driver := driverFunc(func(_ context.Context, input Input) error {
		mu.Lock()
		active++
		if active > maxActive {
			maxActive = active
		}
		order = append(order, string(input.Bytes))
		mu.Unlock()
		if string(input.Bytes) == "terminal_user" {
			close(started)
			<-release
		}
		mu.Lock()
		active--
		mu.Unlock()
		return nil
	})
	adapter := NewOMPAdapterWithVersion(OMPVersion1861, driver)
	defer adapter.Close()
	adapter.Observe(Observation{Lifecycle: LifecycleReady, Mode: string(OmpModeNone)})
	terminalDone := make(chan error, 1)
	go func() {
		terminalDone <- adapter.Router.Route(context.Background(), Input{Capability: CapabilityTUIInput, Action: ActionTUIInput, Source: SourceTerminalUser, Bytes: []byte("terminal_user")})
	}()
	<-started
	planDone := make(chan error, 1)
	go func() {
		planDone <- adapter.Router.Route(context.Background(), Input{Capability: CapabilityOMPPlan, Action: ActionOMPPlanToggle, Source: SourceModeControl, Bytes: []byte(ompPlanToggle)})
	}()
	select {
	case err := <-planDone:
		t.Fatalf("plan completed while terminal write was held: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if err := <-terminalDone; err != nil {
		t.Fatalf("terminal route error = %v", err)
	}
	if err := <-planDone; !errors.Is(err, ErrTUIConfirmationPending) {
		t.Fatalf("plan route error = %v, want pending confirmation", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if maxActive != 1 {
		t.Fatalf("max simultaneous driver calls = %d, want 1", maxActive)
	}
	if len(order) != 2 || order[0] != "terminal_user" || order[1] != ompPlanToggle {
		t.Fatalf("write order = %q, want terminal_user then %q", order, ompPlanToggle)
	}
}

func TestOMPPlanToggleRequiresSafeStateAndMode(t *testing.T) {
	var writes [][]byte
	adapter := NewOMPAdapterWithVersion(OMPVersion1861, driverFunc(func(_ context.Context, input Input) error {
		writes = append(writes, append([]byte(nil), input.Bytes...))
		return nil
	}))
	defer adapter.Close()
	input := Input{Capability: CapabilityOMPPlan, Action: ActionOMPPlanToggle, Source: SourceModeControl, Bytes: []byte(ompPlanToggle)}
	for _, tc := range []struct {
		name        string
		observation Observation
		want        error
	}{
		{"unknown", Observation{InteractionState: string(OmpTuiUnknown), Mode: string(OmpModeNone)}, ErrTUIStateUnknown},
		{"busy", Observation{InteractionState: string(OmpTuiBusy), Mode: string(OmpModeNone)}, ErrTUIStateBusy},
		{"approval", Observation{InteractionState: string(OmpTuiApproval), Mode: string(OmpModeNone)}, ErrTUIStateApproval},
		{"modal", Observation{InteractionState: string(OmpTuiModal), Mode: string(OmpModeNone)}, ErrTUIStateModal},
		{"mode unknown", Observation{Lifecycle: LifecycleReady}, ErrTUIModeUnknown},
		{"goal active", Observation{Lifecycle: LifecycleReady, Mode: string(OmpModeGoalActive)}, ErrOMPPlanGoalActive},
		{"goal paused", Observation{Lifecycle: LifecycleReady, Mode: string(OmpModeGoalPaused)}, ErrOMPPlanGoalActive},
		{"vibe active", Observation{Lifecycle: LifecycleReady, Mode: string(OmpModeVibeActive)}, ErrOMPPlanVibeActive},
		{"plan active", Observation{Lifecycle: LifecycleReady, Mode: string(OmpModePlanActive)}, ErrOMPPlanAlreadyActive},
		{"plan paused", Observation{Lifecycle: LifecycleReady, Mode: string(OmpModePlanPaused)}, ErrOMPPlanAlreadyActive},
	} {
		t.Run(tc.name, func(t *testing.T) {
			adapter.Observe(tc.observation)
			if err := adapter.Router.Route(context.Background(), input); !errors.Is(err, tc.want) {
				t.Fatalf("Route error = %v, want %v", err, tc.want)
			}
		})
	}
	adapter.Observe(Observation{Lifecycle: LifecycleReady, Mode: string(OmpModeNone)})
	if err := adapter.Router.Route(context.Background(), input); !errors.Is(err, ErrTUIConfirmationPending) {
		t.Fatalf("ready route error = %v, want pending confirmation", err)
	}
	if len(writes) != 1 || string(writes[0]) != ompPlanToggle {
		t.Fatalf("writes = %q, want exactly one %q", writes, ompPlanToggle)
	}
}

// TestOMPPlanToggleSucceedsAgainAfterRealModeChangeConfirmation is the
// regression test for the d.written write-once-forever bug: once a
// plan_toggle dispatch is confirmed by a REAL mode transition (the only
// thing that ever changes d.mode in production — see SetModeFromJSONL,
// fired exclusively from a tailed mode_change JSONL line), a second,
// legitimate plan_toggle call on the same driver must also reach the wire.
func TestOMPPlanToggleSucceedsAgainAfterRealModeChangeConfirmation(t *testing.T) {
	var writes [][]byte
	state := NewOmpRuntimeState()
	state.SetProcessAlive(true)
	state.SetBridgeReady(true)
	state.SetMode(OmpAgentModeNone)
	arbiter := NewInputArbiter(driverFunc(func(_ context.Context, input Input) error {
		writes = append(writes, append([]byte(nil), input.Bytes...))
		return nil
	}))
	defer arbiter.Close()
	driver := NewOmpTuiDriver(OMPVersion1861, arbiter, state)
	input := Input{Capability: CapabilityOMPPlan, Action: ActionOMPPlanToggle, Source: SourceModeControl, Bytes: []byte(ompPlanToggle)}

	// 1st toggle: none -> active. Baseline captured as OmpModeUnknown (no
	// Observe call yet classified a mode on this driver).
	if err := driver.Drive(context.Background(), input); !errors.Is(err, ErrTUIConfirmationPending) {
		t.Fatalf("1st toggle error = %v, want pending confirmation", err)
	}
	// Interim busy observation (e.g. agent_start/turn_start) carries no mode
	// change and must NOT clear the latch.
	driver.Observe(Observation{InteractionState: string(OmpTuiBusy)})
	if err := driver.Drive(context.Background(), input); !errors.Is(err, ErrTUIConfirmationPending) {
		t.Fatalf("toggle while latched should still report pending, got %v", err)
	}
	if len(writes) != 1 {
		t.Fatalf("writes after latch-held retry = %d, want 1 (busy observation must not unlatch)", len(writes))
	}
	// Real confirming mode_change observation: active. This diverges from
	// the captured baseline and must clear the latch.
	driver.Observe(Observation{Lifecycle: LifecycleReady, Mode: string(OmpModePlanActive)})
	state.SetMode(OmpAgentModePlan)

	// 2nd toggle: active -> paused. Must reach the wire as a real 2nd write.
	if err := driver.Drive(context.Background(), input); !errors.Is(err, ErrTUIConfirmationPending) {
		t.Fatalf("2nd toggle error = %v, want pending confirmation", err)
	}
	driver.Observe(Observation{Lifecycle: LifecycleReady, Mode: string(OmpModePlanPaused)})
	state.SetMode(OmpAgentModePlanPaused)

	// 3rd toggle: paused -> disabled. Must also reach the wire.
	if err := driver.Drive(context.Background(), input); !errors.Is(err, ErrTUIConfirmationPending) {
		t.Fatalf("3rd toggle error = %v, want pending confirmation", err)
	}

	if len(writes) != 3 {
		t.Fatalf("writes = %d, want 3 (one per real toggle, confirmation-gated latch must reopen each time)", len(writes))
	}
	for i, w := range writes {
		if string(w) != ompPlanToggle {
			t.Fatalf("writes[%d] = %q, want %q", i, w, ompPlanToggle)
		}
	}
}

func TestOMPPlanRouteDescriptorIsAuthoritativeTUI(t *testing.T) {
	adapter := NewOMPAdapterWithVersion(OMPVersion1861, driverFunc(func(context.Context, Input) error { return nil }))
	defer adapter.Close()
	for _, route := range adapter.Descriptor().Routes {
		if route.Capability == CapabilityOMPPlan && route.Action == ActionOMPPlanToggle {
			if route.Transport != TransportTUI || route.Authority != AuthorityAuthoritative || !route.Availability {
				t.Fatalf("plan route = %#v", route)
			}
			return
		}
	}
	t.Fatal("plan route missing")
}

func TestOmpRuntimeStateControlSafety(t *testing.T) {
	s := NewOmpRuntimeState()
	if got := s.ControlSafety().Reason; got != ReasonProcessNotRunning {
		t.Fatalf("initial reason = %s", got)
	}
	s.SetProcessAlive(true)
	if got := s.ControlSafety().Reason; got != ReasonBridgeNotReady {
		t.Fatalf("bridge reason = %s", got)
	}
	s.SetBridgeReady(true)
	if got := s.ControlSafety().Reason; got != ReasonModeUnknown {
		t.Fatalf("mode reason = %s", got)
	}
	s.SetMode(OmpAgentModeNone)
	if got := s.ControlSafety(); !got.Safe || got.Reason != ReasonSafe {
		t.Fatalf("safe = %#v", got)
	}
	s.SetAgentActive(true)
	if got := s.ControlSafety().Reason; got != ReasonAgentActive {
		t.Fatalf("agent reason = %s", got)
	}
	s.SetAgentActive(false)
	s.SetTurnActive(true)
	if got := s.ControlSafety().Reason; got != ReasonTurnActive {
		t.Fatalf("turn reason = %s", got)
	}
	s.SetTurnActive(false)
	s.SetToolCount(1)
	if got := s.ControlSafety().Reason; got != ReasonToolActive {
		t.Fatalf("tool reason = %s", got)
	}
	s.SetToolCount(0)
	s.SetApprovalPending(true)
	if got := s.ControlSafety().Reason; got != ReasonApprovalPending {
		t.Fatalf("approval reason = %s", got)
	}
	s.SetApprovalPending(false)
	s.SetCompacting(true)
	if got := s.ControlSafety().Reason; got != ReasonCompacting {
		t.Fatalf("compacting reason = %s", got)
	}
	s.SetCompacting(false)
	s.SetRetrying(true)
	if got := s.ControlSafety().Reason; got != ReasonRetrying {
		t.Fatalf("retry reason = %s", got)
	}
}

func TestOmpRuntimeStateModeFromGoalUpdated(t *testing.T) {
	s := NewOmpRuntimeState()
	s.SetProcessAlive(true)
	s.SetBridgeReady(true)
	s.SetGoalActive(true, "goal", "active")
	if got := s.ControlSafety().Reason; got != ReasonSafe {
		t.Fatalf("goal mode safety = %s", got)
	}
	s.SetGoalActive(false, "", "")
	if got := s.ControlSafety().Reason; got != ReasonSafe {
		t.Fatalf("none mode safety = %s", got)
	}
}

func TestOmpTuiDriverRuntimeSafetyGate(t *testing.T) {
	state := NewOmpRuntimeState()
	called := false
	arbiter := NewInputArbiter(driverFunc(func(context.Context, Input) error { called = true; return nil }))
	defer arbiter.Close()
	driver := NewOmpTuiDriver(OMPVersion1861, arbiter, state)
	err := driver.Drive(context.Background(), Input{Capability: CapabilityOMPGoal, Action: ActionOMPGoalShow, Bytes: []byte(ompGoalShow)})
	if !errors.Is(err, ErrAutomatedSafetyBlock) || called {
		t.Fatalf("unsafe route err=%v called=%v", err, called)
	}
	state.SetProcessAlive(true)
	state.SetBridgeReady(true)
	state.SetMode(OmpAgentModeNone)
	err = driver.Drive(context.Background(), Input{Capability: CapabilityOMPGoal, Action: ActionOMPGoalShow, Bytes: []byte(ompGoalShow)})
	if !errors.Is(err, ErrTUIConfirmationPending) || !called {
		t.Fatalf("safe route err=%v called=%v", err, called)
	}
}

func TestInputArbiterEpochGatedAutomation(t *testing.T) {
	state := NewOmpRuntimeState()
	state.SetProcessAlive(true)
	state.SetBridgeReady(true)
	state.SetMode(OmpAgentModeNone)
	called := false
	arbiter := NewInputArbiter(driverFunc(func(context.Context, Input) error { called = true; return nil }), state)
	defer arbiter.Close()
	epoch := state.CurrentEpoch()
	state.RecordUserInput()
	err := arbiter.SubmitAutomated(context.Background(), Input{Source: SourceModeControl, Bytes: []byte("/goal show\r")}, epoch, state)
	if !errors.Is(err, ErrInputEpochInvalidated) || called {
		t.Fatalf("mismatch err=%v called=%v", err, called)
	}
	err = arbiter.SubmitAutomated(context.Background(), Input{Source: SourceModeControl, Bytes: []byte("/goal show\r")}, state.CurrentEpoch(), state)
	if err != nil || !called {
		t.Fatalf("matching epoch err=%v called=%v", err, called)
	}
}
