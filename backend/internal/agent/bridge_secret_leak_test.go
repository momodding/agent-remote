package agent

import (
	"bytes"
	"os"
	"regexp"
	"testing"
)

// Test RAR-044: bridge.ts must not leak bridge secrets or write debug logs to /tmp
func TestBridgeTSNoSecretLeakOrDebugLogs(t *testing.T) {
	if len(bridgeTS) == 0 {
		t.Fatal("bridgeTS embedded content is empty")
	}

	rawDisk, err := os.ReadFile("bridge.ts")
	if err != nil {
		t.Fatalf("failed to read bridge.ts from disk: %v", err)
	}

	targets := []struct {
		name    string
		content []byte
	}{
		{"embedded bridgeTS", bridgeTS},
		{"disk bridge.ts", rawDisk},
	}

	forbiddenSubstrings := []string{
		"/tmp/bridge_debug",
		"bridge_debug.log",
		"fs.appendFileSync",
	}

	secretInterpolationRegex := regexp.MustCompile(`secret=\$\{[^}]*secret[^}]*\}`)

	for _, target := range targets {
		for _, forbidden := range forbiddenSubstrings {
			if bytes.Contains(target.content, []byte(forbidden)) {
				t.Errorf("%s contains forbidden debug log string: %q", target.name, forbidden)
			}
		}

		if secretInterpolationRegex.Match(target.content) {
			t.Errorf("%s contains secret interpolation regex match: %q", target.name, secretInterpolationRegex.Find(target.content))
		}
	}
}
