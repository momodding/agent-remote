// Package harness owns a single interactive TUI process's input and observations.
package harness

import (
	"context"
	"errors"
	"sync"
	"time"
)

// HarnessCapability identifies a portable harness capability.
type HarnessCapability string

// HarnessAction identifies a portable harness action.
type HarnessAction string

// Compatibility aliases retain callers of the initial Phase A API.
type Capability = HarnessCapability
type Action = HarnessAction

// HarnessInputSource identifies who originated an interactive write.
type HarnessInputSource string

const (
	SourceTerminalUser        HarnessInputSource = "terminal_user"
	SourceChatPrompt          HarnessInputSource = "chat_prompt"
	SourceChatCommand         HarnessInputSource = "chat_command"
	SourceModeControl         HarnessInputSource = "mode_control"
	SourceInteractionResponse HarnessInputSource = "interaction_response"
	SourceSystemControl       HarnessInputSource = "system_control"
)

const (
	CapabilityTUIInput  Capability = "tui.input"
	ActionTUIInput      Action     = "tui.input.write"
	CapabilityOMPGoal   Capability = "omp.goal"
	ActionOMPGoalShow   Action     = "omp.goal.show"
	CapabilityOMPPlan   Capability = "omp.plan"
	ActionOMPPlanToggle Action     = "omp.plan.toggle"
	CapabilityPrompt    Capability = "prompt"
	ActionPrompt        Action     = "prompt.submit"
	CapabilityAbort     Capability = "abort"
	ActionAbort         Action     = "abort"
	CapabilityModel     Capability = "model"
	ActionModel         Action     = "model.set"
	CapabilityThinking  Capability = "thinking"
	ActionThinking      Action     = "thinking.set"

	// Deprecated OMP-specific names retained for source compatibility.
	CapabilityOMPPrompt   = CapabilityPrompt
	ActionOMPPrompt       = ActionPrompt
	CapabilityOMPAbort    = CapabilityAbort
	ActionOMPAbort        = ActionAbort
	CapabilityOMPModel    = CapabilityModel
	ActionOMPModel        = ActionModel
	CapabilityOMPThinking = CapabilityThinking
	ActionOMPThinking     = ActionThinking
)

const OMPVersion1861 = "18.6.1"

const ompGoalShow = "/goal show\r"

const ompPlanToggle = "/plan\r"

var (
	ErrInputClosed            = errors.New("tui input closed")
	ErrRouteUnknown           = errors.New("tui route unknown")
	ErrRouteDisabled          = errors.New("tui route disabled")
	ErrTUIStateUnknown        = errors.New("omp tui state unknown")
	ErrTUIStateBusy           = errors.New("omp tui state busy")
	ErrTUIStateApproval       = errors.New("omp tui state approval")
	ErrTUIStateModal          = errors.New("omp tui state modal")
	ErrTUIConfirmationPending = errors.New("omp tui command confirmation pending")
	ErrTUIModeUnknown         = errors.New("omp tui mode unknown")
	ErrOMPPlanGoalActive      = errors.New("omp plan blocked by goal mode")
	ErrOMPPlanVibeActive      = errors.New("omp plan blocked by vibe mode")
	ErrOMPPlanAlreadyActive   = errors.New("omp plan toggle rejected while plan mode active")
	ErrAutomatedEpochMismatch = errors.New("automated command epoch mismatch: interaction state changed")
	ErrAutomatedSafetyBlock   = errors.New("automated command blocked by composite safety check")
	ErrInputEpochInvalidated  = errors.New("automated command epoch invalidated")
	ErrAutomatedConfirmation  = errors.New("automated command requires confirmation postcondition")
)

// ControlSafetyReason identifies the first source-backed reason an automated control cannot run.
type ControlSafetyReason string

const (
	ReasonProcessNotRunning ControlSafetyReason = "process_not_running"
	ReasonBridgeNotReady    ControlSafetyReason = "bridge_not_ready"
	ReasonAgentActive       ControlSafetyReason = "agent_active"
	ReasonTurnActive        ControlSafetyReason = "turn_active"
	ReasonToolActive        ControlSafetyReason = "tool_active"
	ReasonApprovalPending   ControlSafetyReason = "approval_pending"
	ReasonCompacting        ControlSafetyReason = "compacting"
	ReasonRetrying          ControlSafetyReason = "retrying"
	ReasonModeUnknown       ControlSafetyReason = "mode_unknown"
	ReasonSafe              ControlSafetyReason = "safe"
)

type ControlSafety struct {
	Safe   bool
	Reason ControlSafetyReason
}

// Legacy guard names remain private implementation compatibility during route migration.
const (
	SafetyOK                    = ReasonSafe
	SafetyEpochChanged          = ReasonBridgeNotReady
	SafetyStateUnknown          = ReasonBridgeNotReady
	SafetyStateBusy             = ReasonAgentActive
	SafetyStateApproval         = ReasonApprovalPending
	SafetyStateModal            = ReasonApprovalPending
	SafetyModeUnknown           = ReasonModeUnknown
	SafetySessionIdentityAbsent = ReasonBridgeNotReady
)

// RuntimeCounters collects observable harness process/bridge/lifecycle event counts.
type RuntimeCounters struct {
	BridgeConnect   uint64 // incremented on each confirmed bridge hello
	LifecycleEvents uint64 // incremented on each lifecycle event delivered to observer
	AutomatedInputs uint64 // incremented on each submitted automated command
	UserInputs      uint64 // incremented on each submitted terminal_user byte write
	EpochAdvances   uint64 // incremented on each monotonic interaction epoch advance
}

// ModeAuthority classifies where an active mode value was sourced.
// The zero value is always ModeAuthorityUnknown; it is never "none".
type ModeAuthority string

const (
	ModeAuthorityUnknown     ModeAuthority = "unknown"      // no confirmed source
	ModeAuthorityBridge      ModeAuthority = "bridge"       // confirmed via bridge HarnessRuntime.SessionMode
	ModeAuthorityBridgeHello ModeAuthority = "bridge_hello" // confirmed via bridge hello frame
	ModeAuthorityJSONL       ModeAuthority = "jsonl"        // confirmed from persisted mode_change entry
)

// SessionIdentityBinding is the stable path pair established on the first bridgeHello.
// Both fields must be non-empty for the binding to be considered valid.
type SessionIdentityBinding struct {
	AgentID        string
	TerminalID     string
	OMPSessionID   string
	OMPSessionFile string
}

// Valid reports whether both OMP identity fields are populated.
func (b SessionIdentityBinding) Valid() bool {
	return b.OMPSessionID != "" && b.OMPSessionFile != ""
}

// CompositeRuntimeObserver accumulates bridge lifecycle/mode observations for one
// agent process.  It is the single authoritative source of bridge-derived
// interaction state, mode authority, session identity, and counters.
// Raw PTY bytes are never accepted as lifecycle evidence.
type CompositeRuntimeObserver struct {
	mu sync.RWMutex

	identity SessionIdentityBinding

	// interactionState derives solely from bridge lifecycle events.
	interactionState OmpTuiState

	// mode derives solely from bridge HarnessRuntime.SessionMode.
	mode          OmpTuiMode
	modeAuthority ModeAuthority

	// epoch is a monotonic counter: advances whenever interactionState transitions.
	epoch uint64

	counters RuntimeCounters

	// downstream is notified on each observation update.
	downstream []TuiObserver
}

func NewCompositeRuntimeObserver() *CompositeRuntimeObserver {
	return &CompositeRuntimeObserver{
		interactionState: OmpTuiUnknown,
		mode:             OmpModeUnknown,
		modeAuthority:    ModeAuthorityUnknown,
	}
}

// ApplyBridgeHello integrates a first-contact bridge hello, establishing identity and
// mode authority. Repeated hellos with different identity are rejected.
func (c *CompositeRuntimeObserver) ApplyBridgeHello(agentID, terminalID, ompSessionID, ompSessionFile, sessionMode string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.identity.Valid() {
		// reject identity mismatches; accept identical re-hello
		if c.identity.OMPSessionID != ompSessionID || c.identity.OMPSessionFile != ompSessionFile {
			return false
		}
	} else {
		c.identity = SessionIdentityBinding{
			AgentID: agentID, TerminalID: terminalID,
			OMPSessionID: ompSessionID, OMPSessionFile: ompSessionFile,
		}
	}
	c.counters.BridgeConnect++
	if sessionMode != "" {
		c.mode = c.classifyMode(sessionMode)
		c.modeAuthority = ModeAuthorityBridgeHello
	}
	if c.interactionState == OmpTuiUnknown {
		c.interactionState = OmpTuiReady
		c.epoch++
		c.counters.EpochAdvances++
	}
	c.notifyLocked()
	return true
}

// ApplyBridgeLifecycle integrates a bridge lifecycle event, advancing interaction state
// and epoch.  Event names are the exact strings from BridgeLifecycleFrame.Event.
// No PTY bytes or synthetic events are accepted here.
func (c *CompositeRuntimeObserver) ApplyBridgeLifecycle(event, sessionMode string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counters.LifecycleEvents++
	prev := c.interactionState
	switch event {
	case "agent_start", "turn_start", "tool_start", "tool_end", "approval_resolved":
		c.interactionState = OmpTuiBusy
	case "approval_requested":
		c.interactionState = OmpTuiApproval
	case "turn_end", "agent_end":
		c.interactionState = OmpTuiReady
	case "session_shutdown":
		c.interactionState = OmpTuiUnknown
	default:
		// unknown bridge event; do not advance state
	}
	if c.interactionState != prev {
		c.epoch++
		c.counters.EpochAdvances++
	}
	if sessionMode != "" {
		c.mode = c.classifyMode(sessionMode)
		c.modeAuthority = ModeAuthorityBridge
	}
	c.notifyLocked()
}

// ApplyBridgeMetadata integrates a metadata update. Mode is updated if sessionMode is
// non-empty. No state or epoch changes.
func (c *CompositeRuntimeObserver) ApplyBridgeMetadata(sessionMode string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if sessionMode != "" {
		c.mode = c.classifyMode(sessionMode)
		c.modeAuthority = ModeAuthorityBridge
	}
	c.notifyLocked()
}

// SetMode records a source-backed canonical OMP mode.
func (c *CompositeRuntimeObserver) SetMode(mode OmpTuiMode, authority ModeAuthority) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mode = mode
	c.modeAuthority = authority
	c.notifyLocked()
}

// SetModeFromJSONL records an OMP 18.6.1 persisted mode_change value.
// Unknown strings fail closed as OmpModeUnknown.
func (c *CompositeRuntimeObserver) SetModeFromJSONL(mode string) {
	c.SetMode(c.classifyMode(mode), ModeAuthorityJSONL)
}

// SetGoalActive records the source-backed goal_updated lifecycle state.
func (c *CompositeRuntimeObserver) SetGoalActive(active bool) {
	if active {
		c.SetMode(OmpModeGoalActive, ModeAuthorityBridge)
		return
	}
	c.SetMode(OmpModeNone, ModeAuthorityBridge)
}

// CurrentMode returns the latest source-backed agent mode.
func (c *CompositeRuntimeObserver) CurrentMode() OmpTuiMode {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.mode
}

// Snapshot returns current state without locking the caller.
func (c *CompositeRuntimeObserver) Snapshot() (state OmpTuiState, mode OmpTuiMode, auth ModeAuthority, epoch uint64, counters RuntimeCounters) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.interactionState, c.mode, c.modeAuthority, c.epoch, c.counters
}

// Identity returns the established session binding (may be invalid).
func (c *CompositeRuntimeObserver) Identity() SessionIdentityBinding {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.identity
}

// AddObserver registers a downstream TuiObserver notified on each state update.
func (c *CompositeRuntimeObserver) AddObserver(observer TuiObserver) {
	if observer == nil {
		return
	}
	c.mu.Lock()
	c.downstream = append(c.downstream, observer)
	c.mu.Unlock()
}

// classifyMode maps OMP 18.6.1 persisted mode_change values and the bridge's
// legacy canonical values to a known enum.
func (c *CompositeRuntimeObserver) classifyMode(raw string) OmpTuiMode {
	switch raw {
	case "none", "":
		return OmpModeNone
	case "goal", "goal-active", "goal_active":
		return OmpModeGoalActive
	case "goal_paused", "goal-paused":
		return OmpModeGoalPaused
	case "vibe", "vibe-active", "vibe_active":
		return OmpModeVibeActive
	case "plan", "plan-active", "plan_active":
		return OmpModePlanActive
	case "plan_paused", "plan-paused":
		return OmpModePlanPaused
	default:
		return OmpModeUnknown
	}
}

func (c *CompositeRuntimeObserver) notifyLocked() {
	obs := Observation{
		Provenance:       Provenance{Source: "bridge", Timestamp: time.Now().UTC()},
		Lifecycle:        LifecycleReady,
		InteractionState: string(c.interactionState),
		Mode:             string(c.mode),
	}
	if c.interactionState == OmpTuiUnknown {
		obs.Lifecycle = LifecycleUnknown
	}
	downstream := append([]TuiObserver(nil), c.downstream...)
	for _, d := range downstream {
		d.Observe(obs)
	}
}

// CompositeControlGuard gates automated commands against composite safety.
// It requires: valid session identity, matching epoch, safe interaction state,
// and for mode-sensitive routes, a known mode. User terminal writes bypass it.
type CompositeControlGuard struct {
	observer *CompositeRuntimeObserver
	counters *RuntimeCounters // pointer into observer.counters
	mu       sync.Mutex
}

func NewCompositeControlGuard(observer *CompositeRuntimeObserver) *CompositeControlGuard {
	return &CompositeControlGuard{observer: observer, counters: &observer.counters}
}

// CheckSafety performs the TOCTOU-safe composite safety check for an automated
// command. It returns the current epoch (to pass back as the confirmation epoch)
// and the reason why the command is unsafe (SafetyOK means safe to dispatch).
// modeSensitive=true additionally requires a known session mode.
func (g *CompositeControlGuard) CheckSafety(expectedEpoch uint64, modeSensitive bool) (currentEpoch uint64, reason ControlSafetyReason) {
	state, mode, _, epoch, _ := g.observer.Snapshot()
	if !g.observer.Identity().Valid() {
		return epoch, SafetySessionIdentityAbsent
	}
	if expectedEpoch != 0 && epoch != expectedEpoch {
		return epoch, SafetyEpochChanged
	}
	switch state {
	case OmpTuiUnknown:
		return epoch, SafetyStateUnknown
	case OmpTuiBusy:
		return epoch, SafetyStateBusy
	case OmpTuiApproval:
		return epoch, SafetyStateApproval
	case OmpTuiModal:
		return epoch, SafetyStateModal
	}
	if modeSensitive && mode == OmpModeUnknown {
		return epoch, SafetyModeUnknown
	}
	return epoch, SafetyOK
}

// RecordAutomatedInput increments the automated command counter thread-safely.
func (g *CompositeControlGuard) RecordAutomatedInput() {
	g.mu.Lock()
	g.observer.mu.Lock()
	g.observer.counters.AutomatedInputs++
	g.observer.mu.Unlock()
	g.mu.Unlock()
}

// RecordUserInput increments the user input counter.
func (g *CompositeControlGuard) RecordUserInput() {
	g.observer.mu.Lock()
	g.observer.counters.UserInputs++
	g.observer.mu.Unlock()
}

type OmpTuiState string

const (
	OmpTuiUnknown  OmpTuiState = "unknown"
	OmpTuiReady    OmpTuiState = "ready"
	OmpTuiBusy     OmpTuiState = "busy"
	OmpTuiApproval OmpTuiState = "approval"
	OmpTuiModal    OmpTuiState = "modal"
)

// OmpTuiMode is a source-backed OMP mode classification. It must be supplied
// by an observer; raw PTY bytes cannot establish it.
type OmpTuiMode string

const (
	OmpModeUnknown    OmpTuiMode = "unknown"
	OmpModeNone       OmpTuiMode = "none"
	OmpModeGoalActive OmpTuiMode = "goal_active"
	OmpModeGoalPaused OmpTuiMode = "goal_paused"
	OmpModeVibeActive OmpTuiMode = "vibe_active"
	OmpModePlanActive OmpTuiMode = "plan_active"
	OmpModePlanPaused OmpTuiMode = "plan_paused"
)

// OmpAgentMode is the exact persisted mode_change vocabulary.
type OmpAgentMode string

const (
	OmpAgentModeNone       OmpAgentMode = "none"
	OmpAgentModePlan       OmpAgentMode = "plan"
	OmpAgentModePlanPaused OmpAgentMode = "plan_paused"
	OmpAgentModeGoal       OmpAgentMode = "goal"
	OmpAgentModeGoalPaused OmpAgentMode = "goal_paused"
	OmpAgentModeVibe       OmpAgentMode = "vibe"
	OmpAgentModeUnknown    OmpAgentMode = "unknown"
)

// OmpRuntimeState combines bridge lifecycle frames and the bound session JSONL.
// It deliberately accepts no terminal bytes as semantic evidence.
type OmpRuntimeState struct {
	mu                                                                                        sync.Mutex
	processAlive, bridgeReady, agentActive, turnActive, approvalPending, compacting, retrying bool
	toolCount                                                                                 int
	mode                                                                                      OmpAgentMode
	inputEpoch                                                                                uint64
}

func NewOmpRuntimeState() *OmpRuntimeState { return &OmpRuntimeState{mode: OmpAgentModeUnknown} }
func (s *OmpRuntimeState) ControlSafety() ControlSafety {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case !s.processAlive:
		return ControlSafety{Reason: ReasonProcessNotRunning}
	case !s.bridgeReady:
		return ControlSafety{Reason: ReasonBridgeNotReady}
	case s.agentActive:
		return ControlSafety{Reason: ReasonAgentActive}
	case s.turnActive:
		return ControlSafety{Reason: ReasonTurnActive}
	case s.toolCount > 0:
		return ControlSafety{Reason: ReasonToolActive}
	case s.approvalPending:
		return ControlSafety{Reason: ReasonApprovalPending}
	case s.compacting:
		return ControlSafety{Reason: ReasonCompacting}
	case s.retrying:
		return ControlSafety{Reason: ReasonRetrying}
	case s.mode == OmpAgentModeUnknown:
		return ControlSafety{Reason: ReasonModeUnknown}
	default:
		return ControlSafety{Safe: true, Reason: ReasonSafe}
	}
}
func (s *OmpRuntimeState) CurrentEpoch() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.inputEpoch
}
func (s *OmpRuntimeState) RecordUserInput()       { s.mu.Lock(); s.inputEpoch++; s.mu.Unlock() }
func (s *OmpRuntimeState) SetProcessAlive(v bool) { s.mu.Lock(); s.processAlive = v; s.mu.Unlock() }
func (s *OmpRuntimeState) SetBridgeReady(v bool)  { s.mu.Lock(); s.bridgeReady = v; s.mu.Unlock() }
func (s *OmpRuntimeState) SetAgentActive(v bool)  { s.mu.Lock(); s.agentActive = v; s.mu.Unlock() }
func (s *OmpRuntimeState) SetTurnActive(v bool)   { s.mu.Lock(); s.turnActive = v; s.mu.Unlock() }
func (s *OmpRuntimeState) SetToolCount(v int)     { s.mu.Lock(); s.toolCount = v; s.mu.Unlock() }
func (s *OmpRuntimeState) SetApprovalPending(v bool) {
	s.mu.Lock()
	s.approvalPending = v
	s.mu.Unlock()
}
func (s *OmpRuntimeState) SetCompacting(v bool) { s.mu.Lock(); s.compacting = v; s.mu.Unlock() }
func (s *OmpRuntimeState) SetRetrying(v bool)   { s.mu.Lock(); s.retrying = v; s.mu.Unlock() }
func (s *OmpRuntimeState) SetGoalActive(active bool, _ string, _ string) {
	if active {
		s.SetMode(OmpAgentModeGoal)
	} else {
		s.SetMode(OmpAgentModeNone)
	}
}
func (s *OmpRuntimeState) SetMode(v OmpAgentMode) { s.mu.Lock(); s.mode = v; s.mu.Unlock() }
func (s *OmpRuntimeState) SetModeFromJSONL(v string) {
	switch OmpAgentMode(v) {
	case OmpAgentModeNone, OmpAgentModePlan, OmpAgentModePlanPaused, OmpAgentModeGoal, OmpAgentModeGoalPaused, OmpAgentModeVibe:
		s.SetMode(OmpAgentMode(v))
	default:
		s.SetMode(OmpAgentModeUnknown)
	}
}

// OmpTuiDriver gates the one source-backed OMP 18.6.1 command route. The
// command comes from packages/coding-agent/src/modes/interactive-mode.ts:6145-55.
// No screen marker has yet been source-verified for command completion, so a
// write remains pending until a future observer adds that evidence.
type OmpTuiDriver struct {
	driver          TuiDriver
	runtime         *OmpRuntimeState
	mu              sync.Mutex
	state           OmpTuiState
	mode            OmpTuiMode
	supported       bool
	written         map[HarnessAction]bool
	writtenBaseline map[HarnessAction]OmpTuiMode
}

func NewOmpTuiDriver(version string, driver TuiDriver, runtime ...*OmpRuntimeState) *OmpTuiDriver {
	var state *OmpRuntimeState
	if len(runtime) > 0 {
		state = runtime[0]
	}
	return &OmpTuiDriver{
		driver: driver, runtime: state, state: OmpTuiUnknown, mode: OmpModeUnknown, supported: version == OMPVersion1861,
		written: make(map[HarnessAction]bool), writtenBaseline: make(map[HarnessAction]OmpTuiMode),
	}
}

// ompInputDispatcher keeps generic terminal input and OMP control actions on
// one arbiter for one terminal process.
type ompInputDispatcher struct {
	driver TuiDriver
	goal   *OmpTuiDriver
}

func (d ompInputDispatcher) Drive(ctx context.Context, input Input) error {
	if (input.Capability == CapabilityOMPGoal && input.Action == ActionOMPGoalShow) ||
		(input.Capability == CapabilityOMPPlan && input.Action == ActionOMPPlanToggle) {
		return d.goal.Drive(ctx, input)
	}
	return d.driver.Drive(ctx, input)
}

// Observe accepts only an explicit classified lifecycle or interaction state.
// Raw terminal bytes are intentionally never interpreted as readiness.
func (d *OmpTuiDriver) Observe(observation Observation) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch OmpTuiState(observation.InteractionState) {
	case OmpTuiBusy, OmpTuiApproval, OmpTuiModal:
		d.state = OmpTuiState(observation.InteractionState)
	case OmpTuiReady:
		d.state = OmpTuiReady
	case OmpTuiUnknown:
		d.state = OmpTuiUnknown
	default:
		if observation.Lifecycle == LifecycleReady {
			d.state = OmpTuiReady
		} else {
			d.state = OmpTuiUnknown
		}
	}
	switch OmpTuiMode(observation.Mode) {
	case OmpModeNone, OmpModeGoalActive, OmpModeGoalPaused, OmpModeVibeActive, OmpModePlanActive, OmpModePlanPaused:
		d.mode = OmpTuiMode(observation.Mode)
		for action, baseline := range d.writtenBaseline {
			if baseline != d.mode {
				delete(d.written, action)
				delete(d.writtenBaseline, action)
			}
		}
	default:
		d.mode = OmpModeUnknown
	}
}

func (d *OmpTuiDriver) Drive(ctx context.Context, input Input) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.supported {
		return ErrRouteDisabled
	}
	isGoalShow := input.Capability == CapabilityOMPGoal && input.Action == ActionOMPGoalShow && string(input.Bytes) == ompGoalShow
	isPlanToggle := input.Capability == CapabilityOMPPlan && input.Action == ActionOMPPlanToggle && string(input.Bytes) == ompPlanToggle
	if !isGoalShow && !isPlanToggle {
		return ErrRouteUnknown
	}
	if d.runtime != nil {
		if safety := d.runtime.ControlSafety(); !safety.Safe {
			return toSafetyError(safety.Reason)
		}
	} else {
		switch d.state {
		case OmpTuiUnknown:
			return ErrTUIStateUnknown
		case OmpTuiBusy:
			return ErrTUIStateBusy
		case OmpTuiApproval:
			return ErrTUIStateApproval
		case OmpTuiModal:
			return ErrTUIStateModal
		}
		if isPlanToggle {
			switch d.mode {
			case OmpModeUnknown:
				return ErrTUIModeUnknown
			case OmpModeGoalActive, OmpModeGoalPaused:
				return ErrOMPPlanGoalActive
			case OmpModeVibeActive:
				return ErrOMPPlanVibeActive
			case OmpModePlanActive, OmpModePlanPaused:
				return ErrOMPPlanAlreadyActive
			}
		}
	}
	if isPlanToggle {
		if d.written[input.Action] {
			return ErrTUIConfirmationPending
		}
		d.written[input.Action] = true
		d.writtenBaseline[input.Action] = d.mode
	}
	var err error
	if d.runtime != nil {
		arbiter, ok := d.driver.(*InputArbiter)
		if !ok {
			if isPlanToggle {
				delete(d.written, input.Action)
				delete(d.writtenBaseline, input.Action)
			}
			return ErrAutomatedSafetyBlock
		}
		epoch := d.runtime.CurrentEpoch()
		err = arbiter.SubmitAutomated(ctx, input, epoch, d.runtime)
	} else {
		err = d.driver.Drive(ctx, input)
	}
	if err != nil {
		if isPlanToggle {
			delete(d.written, input.Action)
			delete(d.writtenBaseline, input.Action)
		}
		return err
	}
	return ErrTUIConfirmationPending
}

// Submit satisfies the submitter interface so Router can dispatch
// source-backed OMP controls (CapabilityOMPGoal/CapabilityOMPPlan) through
// this driver's state/mode/write-once validation rather than the raw arbiter.
func (d *OmpTuiDriver) Submit(ctx context.Context, input Input) error {
	return d.Drive(ctx, input)
}

// Input is an opaque action payload. Drivers must not mutate Bytes.
type Input struct {
	Capability HarnessCapability
	Action     HarnessAction
	Source     HarnessInputSource
	Bytes      []byte
}

// TuiDriver is the sole writer for one interactive process.
type TuiDriver interface {
	Drive(context.Context, Input) error
}

// TuiObserver receives read-only observations from the process.
type TuiObserver interface {
	Observe(Observation)
}

type DriverFunc func(context.Context, Input) error

func (f DriverFunc) Drive(ctx context.Context, input Input) error { return f(ctx, input) }

// ObserverFunc adapts a callback into a safe read-only observer.
type ObserverFunc func(Observation)

func (f ObserverFunc) Observe(observation Observation) { f(observation) }

type HarnessLifecycle string

const (
	LifecycleUnknown HarnessLifecycle = "unknown"
	LifecycleReady   HarnessLifecycle = "ready"
)

type HarnessTransport string

const (
	TransportNativeAPI    HarnessTransport = "native_api"
	TransportExtension    HarnessTransport = "extension"
	TransportSemanticFile HarnessTransport = "semantic_file"
	TransportTUI          HarnessTransport = "tui"
	TransportUnsupported  HarnessTransport = "unsupported"
)

type HarnessAuthority string

const (
	AuthorityAuthoritative HarnessAuthority = "authoritative"
	AuthorityObserved      HarnessAuthority = "observed"
)

// HarnessRuntimeState reports only the adapter's currently known runtime facts.
type HarnessRuntimeState struct {
	Lifecycle        HarnessLifecycle
	InteractionState string
	ActiveMode       string
	FeatureStates    map[HarnessCapability]bool
}

// Provenance identifies where an observation originated.
type Provenance struct {
	Source    string
	Timestamp time.Time
	SessionID string
	ProcessID string
}

type Observation struct {
	Provenance       Provenance
	Lifecycle        HarnessLifecycle
	InteractionState string
	Mode             string
	Bytes            []byte
}

// HarnessActionRoute declares an explicit capability/action route.
type HarnessActionRoute struct {
	Capability   HarnessCapability
	Action       HarnessAction
	Transport    HarnessTransport
	Authority    HarnessAuthority
	Availability bool
	Reason       string
}

// HarnessDescriptor identifies the adapter's actual current route and runtime state.
type HarnessDescriptor struct {
	ID          string
	DisplayName string
	Version     string
	Routes      []HarnessActionRoute
	Runtime     HarnessRuntimeState
}

type inputRequest struct {
	ctx       context.Context
	input     Input
	epoch     uint64
	runtime   *OmpRuntimeState
	automated bool
	done      chan error
}

// InputArbiter is the single FIFO writer for one interactive process.
type InputArbiter struct {
	driver  TuiDriver
	runtime *OmpRuntimeState
	queue   chan inputRequest
	closed  chan struct{}
	once    sync.Once
}

func NewInputArbiter(driver TuiDriver, runtime ...*OmpRuntimeState) *InputArbiter {
	var state *OmpRuntimeState
	if len(runtime) > 0 {
		state = runtime[0]
	}
	a := &InputArbiter{driver: driver, runtime: state, queue: make(chan inputRequest, 64), closed: make(chan struct{})}
	go a.run()
	return a
}
func (a *InputArbiter) run() {
	for {
		select {
		case <-a.closed:
			return
		case request := <-a.queue:
			var err error
			if request.automated {
				if request.runtime.CurrentEpoch() != request.epoch {
					err = ErrInputEpochInvalidated
				} else if safety := request.runtime.ControlSafety(); !safety.Safe {
					err = toSafetyError(safety.Reason)
				} else {
					err = a.driver.Drive(request.ctx, request.input)
				}
			} else {
				err = a.driver.Drive(request.ctx, request.input)
			}
			if !request.automated && request.runtime != nil && request.input.Source == SourceTerminalUser {
				request.runtime.RecordUserInput()
			}
			select {
			case request.done <- err:
			case <-a.closed:
			}
		}
	}
}

// Submit queues terminal user bytes without semantic control gating.
func (a *InputArbiter) Submit(ctx context.Context, input Input) error {
	return a.submit(ctx, input, 0, a.runtime, false)
}

// Drive satisfies TuiDriver for ordinary input routing.
func (a *InputArbiter) Drive(ctx context.Context, input Input) error { return a.Submit(ctx, input) }

// SubmitAutomated rechecks the source-backed user-input epoch immediately before Driver.Drive.
func (a *InputArbiter) SubmitAutomated(ctx context.Context, input Input, requiredEpoch uint64, runtime *OmpRuntimeState) error {
	if runtime == nil {
		return ErrAutomatedSafetyBlock
	}
	if runtime.CurrentEpoch() != requiredEpoch {
		return ErrInputEpochInvalidated
	}
	if safety := runtime.ControlSafety(); !safety.Safe {
		return toSafetyError(safety.Reason)
	}
	return a.submit(ctx, input, requiredEpoch, runtime, true)
}
func (a *InputArbiter) submit(ctx context.Context, input Input, epoch uint64, runtime *OmpRuntimeState, automated bool) error {
	request := inputRequest{ctx: ctx, input: input, epoch: epoch, runtime: runtime, automated: automated, done: make(chan error, 1)}
	select {
	case <-a.closed:
		return ErrInputClosed
	case <-ctx.Done():
		return ctx.Err()
	case a.queue <- request:
	}
	select {
	case <-a.closed:
		return ErrInputClosed
	case <-ctx.Done():
		return ctx.Err()
	case err := <-request.done:
		return err
	}
}
func (a *InputArbiter) Close() { a.once.Do(func() { close(a.closed) }) }

func toSafetyError(reason ControlSafetyReason) error {
	switch reason {
	case ReasonSafe:
		return nil
	case ReasonModeUnknown:
		return ErrTUIModeUnknown
	case ReasonApprovalPending:
		return ErrTUIStateApproval
	case ReasonAgentActive, ReasonTurnActive, ReasonToolActive, ReasonCompacting, ReasonRetrying:
		return ErrTUIStateBusy
	default:
		return ErrAutomatedSafetyBlock
	}
}

// submitter is satisfied by any driver capable of serializing an Input
// through the shared arbiter's safety/epoch/dedup path. Both the raw
// InputArbiter (terminal-user and already-validated automated writes) and
// OmpTuiDriver (source-backed OMP controls with state/mode/write-once
// validation) implement it.
type submitter interface {
	Submit(context.Context, Input) error
}

type route struct {
	spec    HarnessActionRoute
	arbiter submitter
}

// Router resolves only explicitly registered capability/action pairs.
type Router struct {
	mu     sync.RWMutex
	routes map[Capability]map[Action]route
}

func NewRouter() *Router { return &Router{routes: make(map[Capability]map[Action]route)} }

func (r *Router) Register(spec HarnessActionRoute, arbiter submitter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.routes[spec.Capability] == nil {
		r.routes[spec.Capability] = make(map[Action]route)
	}
	r.routes[spec.Capability][spec.Action] = route{spec: spec, arbiter: arbiter}
}

func (r *Router) SetEnabled(capability Capability, action Action, enabled bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	route, ok := r.routes[capability][action]
	if !ok {
		return ErrRouteUnknown
	}
	route.spec.Availability = enabled
	r.routes[capability][action] = route
	return nil
}

func (r *Router) Routes() []HarnessActionRoute {
	r.mu.RLock()
	defer r.mu.RUnlock()
	routes := make([]HarnessActionRoute, 0)
	for _, actions := range r.routes {
		for _, route := range actions {
			routes = append(routes, route.spec)
		}
	}
	return routes
}

func (r *Router) Route(ctx context.Context, input Input) error {
	r.mu.RLock()
	route, ok := r.routes[input.Capability][input.Action]
	r.mu.RUnlock()
	if !ok || route.arbiter == nil {
		return ErrRouteUnknown
	}
	if !route.spec.Availability {
		return ErrRouteDisabled
	}
	return route.arbiter.Submit(ctx, input)
}

// OMPAdapter is the concrete Phase A adapter for the existing interactive OMP process.
type OMPAdapter struct {
	Router     *Router
	Input      *InputArbiter
	goalDriver *OmpTuiDriver
	mu         sync.RWMutex
	observers  []TuiObserver
}

func NewOMPAdapter(driver TuiDriver, runtime ...*OmpRuntimeState) *OMPAdapter {
	input := NewInputArbiter(driver, runtime...)
	router := NewRouter()
	router.Register(HarnessActionRoute{Capability: CapabilityTUIInput, Action: ActionTUIInput, Transport: TransportTUI, Authority: AuthorityAuthoritative, Availability: true}, input)
	for _, route := range []struct {
		capability HarnessCapability
		action     HarnessAction
	}{{CapabilityPrompt, ActionPrompt}, {CapabilityAbort, ActionAbort}, {CapabilityModel, ActionModel}, {CapabilityThinking, ActionThinking}} {
		router.Register(HarnessActionRoute{Capability: route.capability, Action: route.action, Transport: TransportUnsupported, Authority: AuthorityObserved, Availability: false, Reason: "bridge support not confirmed"}, input)
	}
	return &OMPAdapter{Router: router, Input: input}
}

// NewOMPAdapterWithVersion registers only source-backed controls for an exact
// installed OMP version. OMP 18.6.1 defines /goal show at
// packages/coding-agent/src/modes/interactive-mode.ts:6145-55.
func NewOMPAdapterWithVersion(version string, driver TuiDriver, runtime ...*OmpRuntimeState) *OMPAdapter {
	adapter := NewOMPAdapter(driver, runtime...)
	goalDriver := NewOmpTuiDriver(version, adapter.Input, runtime...)
	if version != OMPVersion1861 {
		return adapter
	}
	adapter.goalDriver = goalDriver
	adapter.Router.Register(HarnessActionRoute{
		Capability: CapabilityOMPGoal, Action: ActionOMPGoalShow, Transport: TransportTUI,
		Authority: AuthorityAuthoritative, Availability: true,
		Reason: "OMP 18.6.1 /goal show; completion confirmation unavailable",
	}, goalDriver)
	adapter.Router.Register(HarnessActionRoute{
		Capability: CapabilityOMPPlan, Action: ActionOMPPlanToggle, Transport: TransportTUI,
		Authority: AuthorityAuthoritative, Availability: true,
		Reason: "OMP 18.6.1 /plan; completion confirmation unavailable",
	}, goalDriver)
	return adapter
}

// RouteControl validates and serializes an OMP control through the shared arbiter.
func (a *OMPAdapter) RouteControl(ctx context.Context, input Input) error {
	if a.goalDriver == nil {
		return ErrRouteDisabled
	}
	return a.goalDriver.Drive(ctx, input)
}

func (a *OMPAdapter) Close() {
	a.Input.Close()
}

func (a *OMPAdapter) AddObserver(observer TuiObserver) {
	if observer == nil {
		return
	}
	a.mu.Lock()
	a.observers = append(a.observers, observer)
	a.mu.Unlock()
}

func (a *OMPAdapter) Observe(observation Observation) {
	if a.goalDriver != nil {
		a.goalDriver.Observe(observation)
	}
	a.mu.RLock()
	observers := append([]TuiObserver(nil), a.observers...)
	a.mu.RUnlock()
	for _, observer := range observers {
		observer.Observe(observation)
	}
}

func (a *OMPAdapter) Descriptor() HarnessDescriptor {
	routes := a.Router.Routes()
	features := make(map[HarnessCapability]bool, len(routes))
	for _, route := range routes {
		features[route.Capability] = route.Availability
	}
	return HarnessDescriptor{
		ID: "omp", DisplayName: "OMP", Routes: routes,
		Runtime: HarnessRuntimeState{
			Lifecycle: LifecycleUnknown, InteractionState: "unknown", ActiveMode: "tui", FeatureStates: features,
		},
	}
}
