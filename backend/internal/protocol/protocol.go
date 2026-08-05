package protocol

import "time"

type HealthResponse struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
}

type SessionSummary struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Command   string     `json:"command"`
	CWD       string     `json:"cwd"`
	State     string     `json:"state"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	Preview   []string   `json:"preview"`
	WaitState *WaitState `json:"waitState"`
}

type WaitState struct {
	Kind       string  `json:"kind"`
	Label      string  `json:"label"`
	Confidence float64 `json:"confidence"`
	Matched    string  `json:"matched"`
}

type CreateSessionRequest struct {
	Name    string   `json:"name"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	CWD     string   `json:"cwd"`
	Cols    int      `json:"cols"`
	Rows    int      `json:"rows"`
}

type ResizeSessionRequest struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type InputRequest struct {
	Data string `json:"data"`
}

type WriteFileRequest struct {
	Path           string `json:"path"`
	Content        string `json:"content"`
	ExpectedSHA256 string `json:"expectedSha256"`
}

type RenameFileRequest struct {
	Path    string `json:"path"`
	NewPath string `json:"newPath"`
}

type AuthHello struct {
	Type        string `json:"type"`
	PairingID   string `json:"pairingId"`
	ClientNonce string `json:"clientNonce"`
	ClientName  string `json:"clientName"`
}

type AuthChallenge struct {
	Type        string `json:"type"`
	ServerNonce string `json:"serverNonce"`
	ChallengeID string `json:"challengeId"`
	Salt        string `json:"salt"`
}

type AuthProof struct {
	Type        string `json:"type"`
	PairingID   string `json:"pairingId"`
	ChallengeID string `json:"challengeId"`
	Proof       string `json:"proof"`
}

type AuthOK struct {
	Type         string `json:"type"`
	SessionToken string `json:"sessionToken"`
}

type AuthToken struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

type PTYInputEnvelope struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
}

type PTYOutputEnvelope struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
	Seq       int64  `json:"seq"`
}

type PTYResizeEnvelope struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

type SessionStateEnvelope struct {
	Type      string     `json:"type"`
	SessionID string     `json:"sessionId"`
	State     string     `json:"state"`
	WaitState *WaitState `json:"waitState"`
}

type ErrorEnvelope struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type FileEntry struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	GitCode string `json:"gitCode,omitempty"`
}

type ListFilesResponse struct {
	Entries []FileEntry `json:"entries"`
}

type ReadFileResponse struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Text   string `json:"text"`
}

type GitStatusResponse struct {
	Available bool       `json:"available"`
	Entries   []GitEntry `json:"entries"`
}

type GitEntry struct {
	Code string `json:"code"`
	Path string `json:"path"`
}

type NotifyRegisterRequest struct {
	Provider string `json:"provider"`
	Token string `json:"token"`
}

type ListShellsResponse struct {
	Shells []string `json:"shells"`
}
