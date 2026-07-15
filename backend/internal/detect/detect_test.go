package detect

import (
	"testing"
	"time"
)

func TestDetectWaitStates(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name  string
		input string
		kind  string
		idle  bool
	}{
		{name: "tool call", input: "Running tool now", kind: "claude_tool_call"},
		{name: "plan review", input: "Please approve plan", kind: "claude_plan_review"},
		{name: "codex approval", input: "Codex says approval required", kind: "codex_approval"},
		{name: "gemini input", input: "Gemini waiting for input", kind: "gemini_input"},
		{name: "shell idle", input: "$ ", kind: "shell_prompt_idle", idle: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var d Detector
			if tc.idle {
				d.Push(tc.input, now)
				state := d.Idle(now.Add(600 * time.Millisecond))
				if state == nil || state.Kind != tc.kind {
					t.Fatalf("expected %s, got %#v", tc.kind, state)
				}
				return
			}
			state := d.Push(tc.input, now)
			if state == nil || state.Kind != tc.kind {
				t.Fatalf("expected %s, got %#v", tc.kind, state)
			}
		})
	}
	var d Detector
	_ = d.Push("running tool\n", now)
	_ = d.Push("$ ", now)
	state := d.Idle(now.Add(600 * time.Millisecond))
	if state == nil || state.Kind != "command_completed" {
		t.Fatalf("expected command_completed, got %#v", state)
	}
}

func TestStripANSI(t *testing.T) {
	input := "\x1b[31mred\x1b[0m text"
	if got := StripANSI(input); got != "red text" {
		t.Fatalf("unexpected stripped text: %q", got)
	}
}
