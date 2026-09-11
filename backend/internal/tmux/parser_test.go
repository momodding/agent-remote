package tmux

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

func TestParserFIFOQueue(t *testing.T) {
	input := `%begin 1000 100 0
line1
%end 1000 100 0
`

	reader := io.NopCloser(strings.NewReader(input))
	parser := NewParser(reader)

	// Submit command
	errChan, err := parser.SubmitCommand("list-sessions")
	if err != nil {
		t.Fatal(err)
	}

	// Start parser
	go parser.Start()

	// Wait for result
	select {
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	case <-errChan:
		t.Log("command completed")
	}
}

func TestParserPaneOutput(t *testing.T) {
	input := `%output %0 hello
%output %0 world
`

	reader := io.NopCloser(strings.NewReader(input))
	parser := NewParser(reader)

	// Subscribe before parsing
	outputCh := parser.SubscribePaneOutput("%0")

	go parser.Start()

	// Expect output
	select {
	case data := <-outputCh:
		if string(data.payload) != "hello" {
			t.Errorf("expected 'hello', got %q", string(data.payload))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout on first output")
	}

	select {
	case data := <-outputCh:
		if string(data.payload) != "world" {
			t.Errorf("expected 'world', got %q", string(data.payload))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout on second output")
	}
}

func TestParserCaptureHandoffBuffersBurstExactlyOnce(t *testing.T) {
	parser := NewParser(strings.NewReader(""))
	live := parser.BeginPaneCapture("%0")
	for i := 1; i <= 32; i++ {
		if err := parser.handleLine(fmt.Sprintf("%%output %%0 before-%02d", i)); err != nil {
			t.Fatal(err)
		}
	}
	var pending []byte
	if err := parser.FinishPaneCapture("%0", 16, func(output []byte) error {
		pending = output
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 16; i++ {
		if strings.Contains(string(pending), fmt.Sprintf("before-%02d", i)) {
			t.Fatalf("baseline event before-%02d leaked into pending output", i)
		}
	}
	for i := 17; i <= 32; i++ {
		if count := strings.Count(string(pending), fmt.Sprintf("before-%02d", i)); count != 1 {
			t.Fatalf("pending event before-%02d count = %d, want 1", i, count)
		}
	}
	if err := parser.handleLine("%output %0 live-33"); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-live:
		if string(event.payload) != "live-33" {
			t.Fatalf("live payload = %q, want live-33", event.payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for live output after handoff")
	}
}

func TestParserCaptureFailureReleasesBuffer(t *testing.T) {
	parser := NewParser(strings.NewReader(""))
	live := parser.BeginPaneCapture("%0")
	if err := parser.handleLine("%output %0 captured"); err != nil {
		t.Fatal(err)
	}
	want := errors.New("subscribe failed")
	if err := parser.FinishPaneCapture("%0", 0, func([]byte) error { return want }); !errors.Is(err, want) {
		t.Fatalf("FinishPaneCapture error = %v, want %v", err, want)
	}
	if _, retained := parser.captureOutputs["%0"]; retained {
		t.Fatal("failed capture still retains pane output")
	}
	if err := parser.handleLine("%output %0 live"); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-live:
		if string(event.payload) != "live" {
			t.Fatalf("live payload = %q, want live", event.payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for output after failed capture")
	}
}

func TestParserOctalDecode(t *testing.T) {
	// \101 = 'A', \102 = 'B', \012 = '\n'
	input := `%output %0 \101\102\103
`

	reader := io.NopCloser(strings.NewReader(input))
	parser := NewParser(reader)

	outputCh := parser.SubscribePaneOutput("%0")
	go parser.Start()

	select {
	case data := <-outputCh:
		if string(data.payload) != "ABC" {
			t.Errorf("octal decode failed: got %q", string(data.payload))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestParserNotification(t *testing.T) {
	input := `%sessions-changed
%window-add @0
`

	reader := io.NopCloser(strings.NewReader(input))
	parser := NewParser(reader)

	notifCh := parser.GetNotifications()
	go parser.Start()

	// Expect notifications
	timeout := time.After(2 * time.Second)

	select {
	case n := <-notifCh:
		if n.Type != "sessions-changed" {
			t.Errorf("expected sessions-changed, got %s", n.Type)
		}
	case <-timeout:
		t.Fatal("timeout on first notification")
	}

	select {
	case n := <-notifCh:
		if n.Type != "window-add" || n.WindowID != "@0" {
			t.Errorf("expected window-add @0, got %s %s", n.Type, n.WindowID)
		}
	case <-timeout:
		t.Fatal("timeout on second notification")
	}
}

func TestParserMultipleCommands(t *testing.T) {
	input := `%begin 1000 100 0
output1
%end 1000 100 0
%begin 1000 101 0
output2
%end 1000 101 0
`

	reader := io.NopCloser(strings.NewReader(input))
	parser := NewParser(reader)

	// Submit two commands
	err1, err := parser.SubmitCommand("cmd1")
	if err != nil {
		t.Fatal(err)
	}
	err2, err := parser.SubmitCommand("cmd2")
	if err != nil {
		t.Fatal(err)
	}

	go parser.Start()

	// Wait for both
	select {
	case <-time.After(2 * time.Second):
		t.Fatal("timeout on cmd1")
	case <-err1:
	}

	select {
	case <-time.After(2 * time.Second):
		t.Fatal("timeout on cmd2")
	case <-err2:
	}

	t.Log("both commands completed")
}

func TestParserClose(t *testing.T) {
	input := `%begin 1000 100 0
` // Incomplete

	reader := io.NopCloser(strings.NewReader(input))
	parser := NewParser(reader)

	errChan, err := parser.SubmitCommand("test")
	if err != nil {
		t.Fatal(err)
	}

	go parser.Start()

	// Close while pending
	_ = parser.Close()

	select {
	case <-time.After(1 * time.Second):
		t.Fatal("command should resolve when parser closes")
	case <-errChan:
		t.Log("command failed on close")
	}
}

func TestOctalDecoding(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"simple ASCII", "hello", "hello"},
		{"octal A", "\\101", "A"},
		{"octal ABC", "\\101\\102\\103", "ABC"},
		{"octal newline", "line1\\012line2", "line1\nline2"},
		{"literal backslash", "\\\\", "\\"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := string(decodeOctalEscapes(tt.input))
			if result != tt.expected {
				t.Errorf("decodeOctalEscapes(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestParserIgnoresUnsolicitedBlockBeforeQueuedCommand(t *testing.T) {
	reader, writer := io.Pipe()
	parser := NewParser(reader)
	go func() { _ = parser.Start() }()
	if _, err := io.WriteString(writer, "%begin 1 1 0\n%end 1 1 0\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-parser.Ready():
	case <-time.After(time.Second):
		t.Fatal("parser did not finish startup block")
	}
	resultCh, err := parser.SubmitCommand("display-message")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(writer, "%begin 1 2 0\nready\n%end 1 2 0\n"); err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	result := <-resultCh
	if result == nil || string(result.Output) != "ready" {
		t.Fatalf("result = %+v", result)
	}
}
