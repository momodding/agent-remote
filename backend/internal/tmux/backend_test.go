package tmux

import (
	"strings"
	"testing"
	"time"
)

func TestBackendIdentity(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")

	identity := backend.Identity()
	expected := "tmux:$0:@0:%0"
	if identity != expected {
		t.Errorf("Identity() = %q, want %q", identity, expected)
	}
}

func TestBackendGetPaneID(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%5", "$1", "@2")

	paneID := backend.GetPaneID()
	if paneID != "%5" {
		t.Errorf("GetPaneID() = %q, want %q", paneID, "%5")
	}
}

func TestLiteralSendKeysCommand(t *testing.T) {
	got := literalSendKeysCommand("%12", []byte{'A', '$', 0x1b, '\n'})
	want := "send-keys -l -t %12 \\101 \\044 \\033 \\012"
	if got != want {
		t.Fatalf("literalSendKeysCommand() = %q, want %q", got, want)
	}
}

func TestLiteralSendKeysUTF8(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{
			name: "ASCII text",
			data: []byte("hello"),
			want: "send-keys -l -t %1 \\150 \\145 \\154 \\154 \\157",
		},
		{
			name: "UTF-8 emoji (multi-byte)",
			data: []byte("🚀"), // U+1F680: F0 9F 9A 80
			want: "send-keys -l -t %1 \\360 \\237 \\232 \\200",
		},
		{
			name: "UTF-8 Latin extended",
			data: []byte("café"), // c a f é (C3 A9)
			want: "send-keys -l -t %1 \\143 \\141 \\146 \\303 \\251",
		},
		{
			name: "Mixed ASCII and UTF-8",
			data: []byte("hi🌍x"), // h i F0 9F 8C 8D x
			want: "send-keys -l -t %1 \\150 \\151 \\360 \\237 \\214 \\215 \\170",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := literalSendKeysCommand("%1", tt.data)
			if got != tt.want {
				t.Errorf("literalSendKeysCommand() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLiteralSendKeysMultiline(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{
			name: "Single newline",
			data: []byte("echo\n"), // e=0o145 c=0o143 h=0o150 o=0o157 \n=0o012
			want: "send-keys -l -t %5 \\145 \\143 \\150 \\157 \\012",
		},
		{
			name: "Newline in middle",
			data: []byte("a\nb"), // a=0o141 \n=0o012 b=0o142
			want: "send-keys -l -t %5 \\141 \\012 \\142",
		},
		{
			name: "Multiple newlines",
			data: []byte("a\nb\nc"),
			want: "send-keys -l -t %5 \\141 \\012 \\142 \\012 \\143",
		},
		{
			name: "Trailing newline",
			data: []byte("text\n"), // t=0o164 e=0o145 x=0o170 t=0o164 \n=0o012
			want: "send-keys -l -t %5 \\164 \\145 \\170 \\164 \\012",
		},
		{
			name: "Only newline",
			data: []byte("\n"),
			want: "send-keys -l -t %5 \\012",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := literalSendKeysCommand("%5", tt.data)
			if got != tt.want {
				t.Errorf("literalSendKeysCommand() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLiteralSendKeysControlCharacters(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{
			name: "Ctrl-C (0x03)",
			data: []byte{0x03},
			want: "send-keys -l -t %2 \\003",
		},
		{
			name: "Ctrl-D (0x04)",
			data: []byte{0x04},
			want: "send-keys -l -t %2 \\004",
		},
		{
			name: "Escape (0x1b / 27)",
			data: []byte{0x1b},
			want: "send-keys -l -t %2 \\033",
		},
		{
			name: "Tab (0x09)",
			data: []byte{0x09},
			want: "send-keys -l -t %2 \\011",
		},
		{
			name: "Backspace (0x08)",
			data: []byte{0x08},
			want: "send-keys -l -t %2 \\010",
		},
		{
			name: "Bell (0x07)",
			data: []byte{0x07},
			want: "send-keys -l -t %2 \\007",
		},
		{
			name: "Mixed ctrl and printable",
			data: []byte{0x03, 'x', 0x04}, // 0o003 x=0o170 0o004
			want: "send-keys -l -t %2 \\003 \\170 \\004",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := literalSendKeysCommand("%2", tt.data)
			if got != tt.want {
				t.Errorf("literalSendKeysCommand() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLiteralSendKeysArrowsAndSpecial(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{
			name: "Up arrow ESC sequence",
			data: []byte{0x1b, '[', 'A'}, // \033 [ A
			want: "send-keys -l -t %3 \\033 \\133 \\101",
		},
		{
			name: "Down arrow ESC sequence",
			data: []byte{0x1b, '[', 'B'}, // \033 [ B
			want: "send-keys -l -t %3 \\033 \\133 \\102",
		},
		{
			name: "Left arrow ESC sequence",
			data: []byte{0x1b, '[', 'D'},
			want: "send-keys -l -t %3 \\033 \\133 \\104",
		},
		{
			name: "Right arrow ESC sequence",
			data: []byte{0x1b, '[', 'C'},
			want: "send-keys -l -t %3 \\033 \\133 \\103",
		},
		{
			name: "Delete (0x7f / 127)",
			data: []byte{0x7f},
			want: "send-keys -l -t %3 \\177",
		},
		{
			name: "F1 ESC sequence",
			data: []byte{0x1b, 'O', 'P'}, // \033 O P
			want: "send-keys -l -t %3 \\033 \\117 \\120",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := literalSendKeysCommand("%3", tt.data)
			if got != tt.want {
				t.Errorf("literalSendKeysCommand() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLiteralSendKeysBracketedPaste(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{
			name: "Bracketed paste start marker",
			data: []byte{0x1b, '[', '2', '0', '0', '~'}, // \033 [ 2 0 0 ~
			want: "send-keys -l -t %4 \\033 \\133 \\062 \\060 \\060 \\176",
		},
		{
			name: "Bracketed paste end marker",
			data: []byte{0x1b, '[', '2', '0', '1', '~'}, // \033 [ 2 0 1 ~
			want: "send-keys -l -t %4 \\033 \\133 \\062 \\060 \\061 \\176",
		},
		{
			name: "Text with bracketed paste markers",
			data: []byte{0x1b, '[', '2', '0', '0', '~', 'h', 'i', 0x1b, '[', '2', '0', '1', '~'},
			want: "send-keys -l -t %4 \\033 \\133 \\062 \\060 \\060 \\176 \\150 \\151 \\033 \\133 \\062 \\060 \\061 \\176",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := literalSendKeysCommand("%4", tt.data)
			if got != tt.want {
				t.Errorf("literalSendKeysCommand() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLiteralSendKeysMetaEscape(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{
			name: "Meta-a (Alt+a) as ESC a",
			data: []byte{0x1b, 'a'}, // \033 a
			want: "send-keys -l -t %6 \\033 \\141",
		},
		{
			name: "Meta-x (Alt+x) as ESC x",
			data: []byte{0x1b, 'x'}, // \033 x
			want: "send-keys -l -t %6 \\033 \\170",
		},
		{
			name: "Meta-backspace as ESC backspace",
			data: []byte{0x1b, 0x08}, // \033 \010
			want: "send-keys -l -t %6 \\033 \\010",
		},
		{
			name: "Pipe character",
			data: []byte{'|'}, // | = 124 = 0o174
			want: "send-keys -l -t %6 \\174",
		},
		{
			name: "Backslash",
			data: []byte{'\\'}, // \ = 92 = 0o134
			want: "send-keys -l -t %6 \\134",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := literalSendKeysCommand("%6", tt.data)
			if got != tt.want {
				t.Errorf("literalSendKeysCommand() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBackendReadClosed(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")

	_ = backend.Close()

	buf := make([]byte, 1024)
	_, err := backend.Read(buf)
	if err == nil {
		t.Fatal("Read on closed backend should fail")
	}
}

func TestBackendClosedTwice(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")

	err := backend.Close()
	if err != nil {
		t.Fatalf("first Close failed: %v", err)
	}

	err = backend.Close()
	if err != nil {
		t.Fatalf("second Close failed: %v", err)
	}
}

func TestBackendAliveWhenClosed(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")

	_ = backend.Close()

	if backend.Alive() {
		t.Fatal("Alive should return false after Close")
	}
}

func TestBackendNew(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")

	if backend == nil {
		t.Fatal("backend is nil")
	}

	if !backend.Alive() {
		// Without topology, Alive may return false; that's expected
		// ponytail: Alive depends on topology being populated
	}
}

func TestBackendReadPreservesOutputRemainder(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")
	// Subscribe with baseline data "abcdef"
	ch := make(chan paneOutput)
	err := backend.Subscribe(ch, []byte("abcdef"), nil)
	if err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}
	// Read baseline in chunks
	buf := make([]byte, 3)
	if n, err := backend.Read(buf); err != nil || string(buf[:n]) != "abc" {
		t.Fatalf("first Read() = %q, %v", buf[:n], err)
	}
	if n, err := backend.Read(buf); err != nil || string(buf[:n]) != "def" {
		t.Fatalf("second Read() = %q, %v", buf[:n], err)
	}
}

func TestBackendCloseUnblocksRead(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	client.parser = NewParser(strings.NewReader(""))
	backend := NewTmuxBackend(client, "%0", "$0", "@0")
	result := make(chan error, 1)
	go func() { _, err := backend.Read(make([]byte, 1)); result <- err }()
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("Read should fail after Close")
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not unblock Read")
	}
}

func TestBackendReadEmptyBufferReturnsImmediately(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	client.parser = NewParser(strings.NewReader(""))
	backend := NewTmuxBackend(client, "%0", "$0", "@0")
	result := make(chan error, 1)
	go func() { _, err := backend.Read(nil); result <- err }()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("zero-length Read blocked")
	}
}

func TestBackendTakeBaselineDrainsBaseline(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")
	ch := make(chan paneOutput, 1)
	err := backend.Subscribe(ch, []byte("baseline-data"), []byte("pending-data"))
	if err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}
	if got := string(backend.Baseline()); got != "baseline-data" {
		t.Fatalf("Baseline() = %q, want %q", got, "baseline-data")
	}
	taken := backend.TakeBaseline()
	if string(taken) != "baseline-data" {
		t.Fatalf("TakeBaseline() = %q, want %q", string(taken), "baseline-data")
	}
	if got := backend.Baseline(); len(got) != 0 {
		t.Fatalf("after TakeBaseline, Baseline() = %q, want empty", string(got))
	}
	buf := make([]byte, 64)
	n, err := backend.Read(buf)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if string(buf[:n]) != "pending-data" {
		t.Fatalf("Read() = %q, want %q", string(buf[:n]), "pending-data")
	}
}
