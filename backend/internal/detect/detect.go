package detect

import (
	"regexp"
	"strings"
	"time"
)

type WaitState struct {
	Kind       string  `json:"kind"`
	Label      string  `json:"label"`
	Confidence float64 `json:"confidence"`
	Matched    string  `json:"matched"`
}

type Detector struct {
	window     string
	lastOutput time.Time
	lastState  string
	wasBusy    bool
}

var (
	toolCallPattern   = regexp.MustCompile(`(?i)tool use|tool call|running tool|calling tool`)
	planReviewPattern = regexp.MustCompile(`(?i)plan review|approve plan|review the plan|do you want to proceed`)
	approvalPattern   = regexp.MustCompile(`(?i)approve|approval required|allow command|run this command`)
	codexPattern      = regexp.MustCompile(`(?i)codex|openai`)
	geminiNeedPattern = regexp.MustCompile(`(?i)enter input|waiting for input|need your input`)
	geminiPattern     = regexp.MustCompile(`(?i)gemini`)
	promptPattern     = regexp.MustCompile(`(?m)[$#>] $`)
)

func (d *Detector) Push(output string, now time.Time) *WaitState {
	plain := StripANSI(output)
	d.window = trimWindow(d.window + plain)
	d.lastOutput = now
	if match := toolCallPattern.FindString(d.window); match != "" {
		d.wasBusy = true
		return d.change("claude_tool_call", "Tool call in progress", 0.93, match)
	}
	if match := planReviewPattern.FindString(d.window); match != "" {
		d.wasBusy = true
		return d.change("claude_plan_review", "Plan approval requested", 0.95, match)
	}
	if match := approvalPattern.FindString(d.window); match != "" && codexPattern.FindString(d.window) != "" {
		d.wasBusy = true
		return d.change("codex_approval", "Approval required", 0.9, match)
	}
	if match := geminiNeedPattern.FindString(d.window); match != "" && geminiPattern.FindString(d.window) != "" {
		d.wasBusy = true
		return d.change("gemini_input", "Gemini waiting for input", 0.9, match)
	}
	return nil
}

func (d *Detector) Idle(now time.Time) *WaitState {
	if promptPattern.FindString(d.window) != "" && now.Sub(d.lastOutput) >= 500*time.Millisecond {
		kind := "shell_prompt_idle"
		label := "Shell prompt idle"
		if d.wasBusy {
			kind = "command_completed"
			label = "Command completed"
			d.wasBusy = false
		}
		return d.change(kind, label, 0.8, strings.TrimSpace(lastLine(d.window)))
	}
	return nil
}

func (d *Detector) Exited() *WaitState {
	d.wasBusy = false
	return d.change("command_completed", "Command completed", 1.0, "process exited")
}

func (d *Detector) change(kind, label string, confidence float64, matched string) *WaitState {
	key := kind + ":" + matched
	if d.lastState == key {
		return nil
	}
	d.lastState = key
	return &WaitState{Kind: kind, Label: label, Confidence: confidence, Matched: matched}
}

func trimWindow(input string) string {
	if len(input) <= 8192 {
		return input
	}
	return input[len(input)-8192:]
}

func lastLine(input string) string {
	parts := strings.Split(strings.TrimRight(input, "\n"), "\n")
	if len(parts) == 0 {
		return input
	}
	return parts[len(parts)-1]
}
