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
