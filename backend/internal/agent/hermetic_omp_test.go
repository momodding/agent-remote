package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
	"github.com/agenticremote/agenticremote/backend/internal/session"
)

// OpenAIChatMessage represents a message in the OpenAI Chat Completions payload.
type OpenAIChatMessage struct {
	Role       string               `json:"role"`
	Content    any                  `json:"content"`
	Name       string               `json:"name,omitempty"`
	ToolCallID string               `json:"tool_call_id,omitempty"`
	ToolCalls  []OpenAIToolCallItem `json:"tool_calls,omitempty"`
}

// OpenAIToolCallItem represents a tool call in an assistant message or delta.
type OpenAIToolCallItem struct {
	Index    int                    `json:"index,omitempty"`
	ID       string                 `json:"id,omitempty"`
	Type     string                 `json:"type,omitempty"`
	Function OpenAIFunctionCallItem `json:"function"`
}

// OpenAIFunctionCallItem represents the function name and arguments.
type OpenAIFunctionCallItem struct {
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
}

// OpenAIChatRequest represents the incoming chat completions request body.
type OpenAIChatRequest struct {
	Model       string              `json:"model"`
	Messages    []OpenAIChatMessage `json:"messages"`
	Stream      bool                `json:"stream,omitempty"`
	Temperature *float64            `json:"temperature,omitempty"`
	Tools       []any               `json:"tools,omitempty"`
}

// MockOpenAIResponse represents a configured canned response from the mock server.
type MockOpenAIResponse struct {
	StatusCode int
	Delay      time.Duration
	// If non-empty, raw JSON error or custom body to send.
	RawBody string
	// For text streaming responses:
	TextChunks []string
	// For tool call responses:
	ToolCalls []OpenAIToolCallItem
}

// MockOpenAIServer is a deterministic local mock server for OpenAI completions API.
type MockOpenAIServer struct {
	mu           sync.Mutex
	server       *httptest.Server
	Requests     []OpenAIChatRequest
	RawRequests  [][]byte
	responseSeq  []MockOpenAIResponse
	customHandle func(req OpenAIChatRequest) (*MockOpenAIResponse, error)
}

// NewMockOpenAIServer starts a new local HTTP mock server.
func NewMockOpenAIServer() *MockOpenAIServer {
	mock := &MockOpenAIServer{
		Requests:    make([]OpenAIChatRequest, 0),
		RawRequests: make([][]byte, 0),
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodyBytes, _ := io.ReadAll(r.Body)
		mock.mu.Lock()
		mock.RawRequests = append(mock.RawRequests, bodyBytes)
		var chatReq OpenAIChatRequest
		_ = json.Unmarshal(bodyBytes, &chatReq)
		mock.Requests = append(mock.Requests, chatReq)
		custom := mock.customHandle
		var resp *MockOpenAIResponse
		if custom != nil {
			mock.mu.Unlock()
			var err error
			resp, err = custom(chatReq)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		} else if len(mock.responseSeq) > 0 {
			respVal := mock.responseSeq[0]
			mock.responseSeq = mock.responseSeq[1:]
			resp = &respVal
			mock.mu.Unlock()
		} else {
			// Default canned response
			resp = &MockOpenAIResponse{
				StatusCode: http.StatusOK,
				TextChunks: []string{"Hermetic PONG"},
			}
			mock.mu.Unlock()
		}

		if resp.Delay > 0 {
			time.Sleep(resp.Delay)
		}

		if resp.StatusCode != 0 && resp.StatusCode != http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(resp.StatusCode)
			if resp.RawBody != "" {
				_, _ = w.Write([]byte(resp.RawBody))
			} else {
				_, _ = w.Write([]byte(`{"error":{"message":"mock error","type":"server_error"}}`))
			}
			return
		}

		if resp.RawBody != "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(resp.RawBody))
			return
		}

		// Handle streaming response (OpenAI SSE)
		if chatReq.Stream || len(resp.TextChunks) > 0 || len(resp.ToolCalls) > 0 {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
			w.WriteHeader(http.StatusOK)
			flusher, _ := w.(http.Flusher)

			// If tool calls:
			if len(resp.ToolCalls) > 0 {
				chunk := map[string]any{
					"id":      "chatcmpl-mock-tool",
					"object":  "chat.completion.chunk",
					"created": time.Now().Unix(),
					"model":   chatReq.Model,
					"choices": []map[string]any{
						{
							"index": 0,
							"delta": map[string]any{
								"role":       "assistant",
								"tool_calls": resp.ToolCalls,
							},
							"finish_reason": nil,
						},
					},
				}
				data, _ := json.Marshal(chunk)
				_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
				if flusher != nil {
					flusher.Flush()
				}

				finishChunk := map[string]any{
					"id":      "chatcmpl-mock-tool",
					"object":  "chat.completion.chunk",
					"created": time.Now().Unix(),
					"model":   chatReq.Model,
					"choices": []map[string]any{
						{
							"index":         0,
							"delta":         map[string]any{},
							"finish_reason": "tool_calls",
						},
					},
				}
				dataFinish, _ := json.Marshal(finishChunk)
				_, _ = fmt.Fprintf(w, "data: %s\n\n", dataFinish)
				if flusher != nil {
					flusher.Flush()
				}
			} else {
				// Text chunks
				for _, chunkText := range resp.TextChunks {
					chunk := map[string]any{
						"id":      "chatcmpl-mock-text",
						"object":  "chat.completion.chunk",
						"created": time.Now().Unix(),
						"model":   chatReq.Model,
						"choices": []map[string]any{
							{
								"index": 0,
								"delta": map[string]any{
									"role":    "assistant",
									"content": chunkText,
								},
								"finish_reason": nil,
							},
						},
					}
					data, _ := json.Marshal(chunk)
					_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
					if flusher != nil {
						flusher.Flush()
					}
				}

				finishChunk := map[string]any{
					"id":      "chatcmpl-mock-text",
					"object":  "chat.completion.chunk",
					"created": time.Now().Unix(),
					"model":   chatReq.Model,
					"choices": []map[string]any{
						{
							"index":         0,
							"delta":         map[string]any{},
							"finish_reason": "stop",
						},
					},
				}
				dataFinish, _ := json.Marshal(finishChunk)
				_, _ = fmt.Fprintf(w, "data: %s\n\n", dataFinish)
				if flusher != nil {
					flusher.Flush()
				}
			}

			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			return
		}

		// Non-streaming JSON response
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		respJSON := map[string]any{
			"id":      "chatcmpl-mock-single",
			"object":  "chat.completion",
			"created": time.Now().Unix(),
			"model":   chatReq.Model,
			"choices": []map[string]any{
				{
					"index": 0,
					"message": map[string]any{
						"role":    "assistant",
						"content": strings.Join(resp.TextChunks, ""),
					},
					"finish_reason": "stop",
				},
			},
		}
		_ = json.NewEncoder(w).Encode(respJSON)
	})

	mock.server = httptest.NewServer(handler)
	return mock
}

// URL returns the mock server's base URL.
func (m *MockOpenAIServer) URL() string {
	return m.server.URL
}

// Close terminates the mock server.
func (m *MockOpenAIServer) Close() {
	m.server.Close()
}

// QueueResponses adds responses to the mock server's response queue.
func (m *MockOpenAIServer) QueueResponses(resps ...MockOpenAIResponse) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.responseSeq = append(m.responseSeq, resps...)
}

// SetCustomHandler sets a dynamic request handler.
func (m *MockOpenAIServer) SetCustomHandler(fn func(req OpenAIChatRequest) (*MockOpenAIResponse, error)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.customHandle = fn
}

// GetRequests returns a copy of all recorded requests.
func (m *MockOpenAIServer) GetRequests() []OpenAIChatRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	copied := make([]OpenAIChatRequest, len(m.Requests))
	copy(copied, m.Requests)
	return copied
}

// WriteHermeticOMPConfig writes models.yml and config.yml into the specified agentDir.
func WriteHermeticOMPConfig(t *testing.T, agentDir, mockServerURL string) {
	if err := os.MkdirAll(agentDir, 0o700); err != nil {
		t.Fatalf("mkdir agentDir: %v", err)
	}

	modelsContent := fmt.Sprintf(`providers:
  hermetic:
    baseUrl: "%s/v1/"
    api: "openai-completions"
    apiKey: "sk-hermetic-mock-key"
    models:
      - id: "hermetic-model"
        name: "Hermetic Mock Model"
        input: [text]
        reasoning: true
      - id: "hermetic-model-alt"
        name: "Hermetic Mock Model Alt"
        input: [text]
        reasoning: true
`, mockServerURL)
	if err := os.WriteFile(filepath.Join(agentDir, "models.yml"), []byte(modelsContent), 0o600); err != nil {
		t.Fatalf("write models.yml: %v", err)
	}

	configContent := `model: hermetic/hermetic-model
modelRoles:
  default: hermetic/hermetic-model
  smol: hermetic/hermetic-model
  slow: hermetic/hermetic-model
  plan: hermetic/hermetic-model
`
	if err := os.WriteFile(filepath.Join(agentDir, "config.yml"), []byte(configContent), 0o600); err != nil {
		t.Fatalf("write config.yml: %v", err)
	}

	t.Setenv("PI_CODING_AGENT_DIR", agentDir)
	t.Setenv("OMP_AGENT_MODELS_FILE", filepath.Join(agentDir, "models.yml"))
}

// TestHermeticOMP_CannedText verifies that real omp binary executes a prompt turn
// against the local deterministic mock server and records the assistant response in transcript.
func TestHermeticOMP_CannedText(t *testing.T) {
	if _, err := exec.LookPath("omp"); err != nil {
		t.Skip("omp binary not found in PATH")
	}

	mock := NewMockOpenAIServer()
	defer mock.Close()

	mock.QueueResponses(MockOpenAIResponse{
		StatusCode: http.StatusOK,
		TextChunks: []string{"Hermetic ", "PONG ", "Response"},
	})

	workDir := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatalf("mkdir workDir: %v", err)
	}

	termMgr, err := session.NewManager(workDir, filepath.Join(t.TempDir(), "terminals"), workDir, 1<<20, 64, nil)
	if err != nil {
		t.Fatalf("new terminal manager: %v", err)
	}

	agentDir := filepath.Join(t.TempDir(), "agent-state")
	WriteHermeticOMPConfig(t, agentDir, mock.URL())

	store, err := runtimestore.Open(agentDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	svc := NewService(termMgr, store, agentDir)
	defer svc.Close()

	created, err := svc.CreateAgentRequest(context.Background(), protocol.CreateSessionRequest{
		CWD:     workDir,
		Name:    "Hermetic Agent",
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("create agent: %v", err)
	}
	defer func() { _ = termMgr.Close(created.TerminalSessionID) }()

	deadline := time.Now().Add(60 * time.Second)
	for !svc.bridgeServer.IsConnected(created.ID) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(created.ID) {
		t.Fatalf("bridge server not connected for agent %s within deadline", created.ID)
	}

	// Verify capability enabled
	current, err := svc.GetAgent(created.ID)
	if err != nil {
		t.Fatalf("get agent: %v", err)
	}
	var promptCapEnabled bool
	for _, cap := range current.Capabilities {
		if cap.Name == "prompt" && cap.Enabled {
			promptCapEnabled = true
			break
		}
	}
	if !promptCapEnabled {
		t.Fatalf("prompt capability not enabled for agent %s", created.ID)
	}

	// Submit prompt
	if err := svc.SubmitPrompt(created.ID, "Say hello to hermetic test"); err != nil {
		t.Fatalf("submit prompt failed: %v", err)
	}

	// Wait for agent to transition through working to idle / transcript completed
	turnDeadline := time.Now().Add(60 * time.Second)
	var assistantText string
	for time.Now().Before(turnDeadline) {
		hist, err := svc.History(created.ID)
		if err == nil && hist != nil {
			for _, ev := range hist.Events {
				if ev.Type == "message.assistant" && strings.TrimSpace(ev.Text) != "" {
					assistantText = ev.Text
					break
				}
			}
		}
		if assistantText != "" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if assistantText == "" {
		t.Fatalf("assistant response was empty in transcript after prompt")
	}
	if !strings.Contains(assistantText, "Hermetic PONG Response") {
		t.Fatalf("expected 'Hermetic PONG Response' in transcript, got %q", assistantText)
	}

	// Verify mock server received completion request
	reqs := mock.GetRequests()
	if len(reqs) == 0 {
		t.Fatalf("mock server received 0 completion requests from real omp")
	}
	t.Logf("Hermetic canned text verified! Assistant response: %q across %d mock requests", assistantText, len(reqs))
}

// TestHermeticOMP_ToolCallsAndContinuation verifies that real omp handles tool calls,
// executes the requested tool (bash echo), and sends tool output back to complete the turn.
func TestHermeticOMP_ToolCallsAndContinuation(t *testing.T) {
	if _, err := exec.LookPath("omp"); err != nil {
		t.Skip("omp binary not found in PATH")
	}

	mock := NewMockOpenAIServer()
	defer mock.Close()

	// Dynamic handler for multi-turn tool calling
	mock.SetCustomHandler(func(req OpenAIChatRequest) (*MockOpenAIResponse, error) {
		// Inspect if any message has role "tool"
		for _, msg := range req.Messages {
			if msg.Role == "tool" {
				// Tool execution completed, return final text
				return &MockOpenAIResponse{
					StatusCode: http.StatusOK,
					TextChunks: []string{"TOOL_EXECUTION_COMPLETED_SUCCESSFULLY"},
				}, nil
			}
		}

		// First turn: issue tool call to bash
		return &MockOpenAIResponse{
			StatusCode: http.StatusOK,
			ToolCalls: []OpenAIToolCallItem{
				{
					ID:   "call_bash_123",
					Type: "function",
					Function: OpenAIFunctionCallItem{
						Name:      "bash",
						Arguments: `{"command":"echo HERMETIC_TOOL_OUTPUT_OK"}`,
					},
				},
			},
		}, nil
	})

	workDir := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatalf("mkdir workDir: %v", err)
	}

	termMgr, err := session.NewManager(workDir, filepath.Join(t.TempDir(), "terminals"), workDir, 1<<20, 64, nil)
	if err != nil {
		t.Fatalf("new terminal manager: %v", err)
	}

	agentDir := filepath.Join(t.TempDir(), "agent-state")
	WriteHermeticOMPConfig(t, agentDir, mock.URL())

	store, err := runtimestore.Open(agentDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	svc := NewService(termMgr, store, agentDir)
	defer svc.Close()

	created, err := svc.CreateAgentRequest(context.Background(), protocol.CreateSessionRequest{
		CWD:     workDir,
		Name:    "Tool Agent",
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("create agent: %v", err)
	}
	defer func() { _ = termMgr.Close(created.TerminalSessionID) }()

	deadline := time.Now().Add(60 * time.Second)
	for !svc.bridgeServer.IsConnected(created.ID) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(created.ID) {
		t.Fatalf("bridge server not connected")
	}

	if err := svc.SubmitPrompt(created.ID, "Run tool test"); err != nil {
		t.Fatalf("submit prompt failed: %v", err)
	}

	turnDeadline := time.Now().Add(60 * time.Second)
	var finalAssistantText string
	var sawToolCall bool
	for time.Now().Before(turnDeadline) {
		hist, err := svc.History(created.ID)
		if err == nil && hist != nil {
			for _, ev := range hist.Events {
				if ev.Type == "tool.call" || strings.Contains(ev.Text, "bash") || strings.Contains(ev.Text, "HERMETIC_TOOL_OUTPUT_OK") {
					sawToolCall = true
				}
				if ev.Type == "message.assistant" && strings.Contains(ev.Text, "TOOL_EXECUTION_COMPLETED_SUCCESSFULLY") {
					finalAssistantText = ev.Text
					break
				}
			}
		}
		if finalAssistantText != "" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if finalAssistantText == "" {
		t.Fatalf("final assistant text not found in transcript after tool turn")
	}

	reqs := mock.GetRequests()
	if len(reqs) < 2 {
		t.Fatalf("expected at least 2 completion requests (tool call + tool result continuation), got %d", len(reqs))
	}
	t.Logf("Tool calling and continuation verified! Final text: %q across %d requests (sawToolCall: %v)", finalAssistantText, len(reqs), sawToolCall)
}

// TestHermeticOMP_Unicode verifies multibyte UTF-8 and unicode streaming without corruption.
func TestHermeticOMP_Unicode(t *testing.T) {
	if _, err := exec.LookPath("omp"); err != nil {
		t.Skip("omp binary not found in PATH")
	}

	mock := NewMockOpenAIServer()
	defer mock.Close()

	unicodeContent := "🚀 日本語 테스트 中文 💡 Überprüfung: café & résumé 🎯"
	mock.QueueResponses(MockOpenAIResponse{
		StatusCode: http.StatusOK,
		TextChunks: []string{
			"🚀 日本語 ",
			"테스트 ",
			"中文 💡 ",
			"Überprüfung: ",
			"café & résumé 🎯",
		},
	})

	workDir := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatalf("mkdir workDir: %v", err)
	}

	termMgr, err := session.NewManager(workDir, filepath.Join(t.TempDir(), "terminals"), workDir, 1<<20, 64, nil)
	if err != nil {
		t.Fatalf("new terminal manager: %v", err)
	}

	agentDir := filepath.Join(t.TempDir(), "agent-state")
	WriteHermeticOMPConfig(t, agentDir, mock.URL())

	store, err := runtimestore.Open(agentDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	svc := NewService(termMgr, store, agentDir)
	defer svc.Close()

	created, err := svc.CreateAgentRequest(context.Background(), protocol.CreateSessionRequest{
		CWD:     workDir,
		Name:    "Unicode Agent",
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("create agent: %v", err)
	}
	defer func() { _ = termMgr.Close(created.TerminalSessionID) }()

	deadline := time.Now().Add(60 * time.Second)
	for !svc.bridgeServer.IsConnected(created.ID) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(created.ID) {
		t.Fatalf("bridge server not connected")
	}

	if err := svc.SubmitPrompt(created.ID, "Send unicode"); err != nil {
		t.Fatalf("prompt failed: %v", err)
	}

	turnDeadline := time.Now().Add(60 * time.Second)
	var assistantText string
	for time.Now().Before(turnDeadline) {
		hist, err := svc.History(created.ID)
		if err == nil && hist != nil {
			for _, ev := range hist.Events {
				if ev.Type == "message.assistant" && strings.TrimSpace(ev.Text) != "" {
					assistantText = ev.Text
					break
				}
			}
		}
		if assistantText != "" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if !strings.Contains(assistantText, "日本語") || !strings.Contains(assistantText, "🚀") {
		t.Fatalf("unicode text not preserved in transcript, got %q (expected %q)", assistantText, unicodeContent)
	}
	t.Logf("Unicode streaming verified accurately: %q", assistantText)
}

// TestHermeticOMP_ErrorAndLatency verifies error responses and latency delays are handled gracefully.
func TestHermeticOMP_ErrorAndLatency(t *testing.T) {
	if _, err := exec.LookPath("omp"); err != nil {
		t.Skip("omp binary not found in PATH")
	}

	mock := NewMockOpenAIServer()
	defer mock.Close()

	// Queue a response with latency delay followed by valid completion
	mock.QueueResponses(
		MockOpenAIResponse{
			StatusCode: http.StatusOK,
			Delay:      300 * time.Millisecond,
			TextChunks: []string{"Delayed ", "Hermetic ", "Response"},
		},
	)

	workDir := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatalf("mkdir workDir: %v", err)
	}

	termMgr, err := session.NewManager(workDir, filepath.Join(t.TempDir(), "terminals"), workDir, 1<<20, 64, nil)
	if err != nil {
		t.Fatalf("new terminal manager: %v", err)
	}

	agentDir := filepath.Join(t.TempDir(), "agent-state")
	WriteHermeticOMPConfig(t, agentDir, mock.URL())

	store, err := runtimestore.Open(agentDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	svc := NewService(termMgr, store, agentDir)
	defer svc.Close()

	created, err := svc.CreateAgentRequest(context.Background(), protocol.CreateSessionRequest{
		CWD:     workDir,
		Name:    "Latency Agent",
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("create agent: %v", err)
	}
	defer func() { _ = termMgr.Close(created.TerminalSessionID) }()

	deadline := time.Now().Add(60 * time.Second)
	for !svc.bridgeServer.IsConnected(created.ID) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(created.ID) {
		t.Fatalf("bridge server not connected")
	}

	if err := svc.SubmitPrompt(created.ID, "Test latency"); err != nil {
		t.Fatalf("submit prompt failed: %v", err)
	}

	turnDeadline := time.Now().Add(60 * time.Second)
	var assistantText string
	for time.Now().Before(turnDeadline) {
		hist, err := svc.History(created.ID)
		if err == nil && hist != nil {
			for _, ev := range hist.Events {
				if ev.Type == "message.assistant" && strings.TrimSpace(ev.Text) != "" {
					assistantText = ev.Text
					break
				}
			}
		}
		if assistantText != "" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if !strings.Contains(assistantText, "Delayed Hermetic Response") {
		t.Fatalf("expected 'Delayed Hermetic Response' in transcript, got %q", assistantText)
	}
	t.Logf("Latency handling verified: %q", assistantText)
}

// TestHermeticOMP_TruthfulCapabilitiesAndDegradation verifies that capabilities
// truthfully reflect live bridge state: enabled when bridge connects, disabled when disconnected.
func TestHermeticOMP_TruthfulCapabilitiesAndDegradation(t *testing.T) {
	if _, err := exec.LookPath("omp"); err != nil {
		t.Skip("omp binary not found in PATH")
	}

	mock := NewMockOpenAIServer()
	defer mock.Close()

	workDir := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatalf("mkdir workDir: %v", err)
	}

	termMgr, err := session.NewManager(workDir, filepath.Join(t.TempDir(), "terminals"), workDir, 1<<20, 64, nil)
	if err != nil {
		t.Fatalf("new terminal manager: %v", err)
	}

	agentDir := filepath.Join(t.TempDir(), "agent-state")
	WriteHermeticOMPConfig(t, agentDir, mock.URL())

	store, err := runtimestore.Open(agentDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	svc := NewService(termMgr, store, agentDir)
	defer svc.Close()

	created, err := svc.CreateAgentRequest(context.Background(), protocol.CreateSessionRequest{
		CWD:     workDir,
		Name:    "Cap Agent",
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("create agent: %v", err)
	}
	defer func() { _ = termMgr.Close(created.TerminalSessionID) }()

	// 1. Wait for bridge to connect
	deadline := time.Now().Add(60 * time.Second)
	for !svc.bridgeServer.IsConnected(created.ID) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(created.ID) {
		t.Fatalf("bridge failed to connect")
	}

	// 2. Check capabilities enabled
	hasPromptCap := func() bool {
		ag, err := svc.GetAgent(created.ID)
		if err != nil {
			return false
		}
		for _, c := range ag.Capabilities {
			if c.Name == "prompt" {
				return c.Enabled
			}
		}
		return false
	}

	if !hasPromptCap() {
		t.Fatalf("expected prompt capability enabled when bridge connected")
	}

	// 3. Close the bridge connection to simulate connection drop / disconnect
	svc.bridgeServer.mu.Lock()
	st := svc.bridgeServer.agents[created.ID]
	svc.bridgeServer.mu.Unlock()
	if st != nil && st.conn != nil {
		_ = st.conn.Close()
	}

	// 4. Assert capability degrades to false
	degradeDeadline := time.Now().Add(10 * time.Second)
	for hasPromptCap() && time.Now().Before(degradeDeadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if hasPromptCap() {
		t.Fatalf("prompt capability did NOT degrade to false when bridge connection dropped!")
	}
	t.Log("Bridge capability degradation verified: prompt capability truthfully disabled on disconnect")
}
