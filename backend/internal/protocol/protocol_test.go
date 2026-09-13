package protocol

import (
	"encoding/json"
	"testing"
)

func TestAgentControlEnvelopesUseWireFieldNames(t *testing.T) {
	input, err := json.Marshal(ChannelOpenEnvelope{
		Type: "channel.open", RequestID: "request-1", ChannelID: "channel-1", Kind: "agent", TargetID: "agent-1", After: 7,
	})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(input, &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"type", "requestId", "channelId", "kind", "targetId", "after"} {
		if _, ok := fields[field]; !ok {
			t.Errorf("missing %q in %s", field, input)
		}
	}
}

func TestCreateSessionRequestBackendField(t *testing.T) {
	req := CreateSessionRequest{
		Name:    "test",
		Command: "sh",
		Args:    []string{"-c", "echo hi"},
		CWD:     "/home",
		Cols:    80,
		Rows:    24,
		Backend: "pty",
	}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var decoded CreateSessionRequest
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Backend != "pty" {
		t.Fatalf("expected backend %q, got %q", "pty", decoded.Backend)
	}
}
