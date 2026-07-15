package detect

import "regexp"

var csiPattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
var oscPattern = regexp.MustCompile(`\x1b\].*?(\x07|\x1b\\)`)

func StripANSI(input string) string {
	withoutOSC := oscPattern.ReplaceAllString(input, "")
	return csiPattern.ReplaceAllString(withoutOSC, "")
}
