package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	"github.com/coder/websocket"
)

func requireBinary(t *testing.T, name string) string {
	t.Helper()
	path, err := exec.LookPath(name)
	if err != nil {
		if os.Getenv("AGENTICREMOTE_STRICT_INTEGRATION") == "1" {
			t.Fatalf("AGENTICREMOTE_STRICT_INTEGRATION=1: %s binary required but not found in PATH", name)
		}
		t.Skipf("%s binary not found in PATH; skipping test", name)
	}
	return path
}

// wsStream adapts a WebSocket binary connection into an io.Reader and io.Writer,
// correctly accumulating byte streams across arbitrary WebSocket message boundaries.
type wsStream struct {
	ctx  context.Context
	conn *websocket.Conn
	buf  []byte
}

func (s *wsStream) Read(p []byte) (int, error) {
	for len(s.buf) == 0 {
		msgType, data, err := s.conn.Read(s.ctx)
		if err != nil {
			return 0, err
		}
		if msgType != websocket.MessageBinary {
			return 0, fmt.Errorf("unexpected non-binary WS message type: %v", msgType)
		}
		s.buf = data
	}
	n := copy(p, s.buf)
	s.buf = s.buf[n:]
	return n, nil
}

func (s *wsStream) Write(p []byte) (int, error) {
	err := s.conn.Write(s.ctx, websocket.MessageBinary, p)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func startXvfbAndVNC(t *testing.T, ctx context.Context) (int, func()) {
	t.Helper()
	requireBinary(t, "Xvfb")
	requireBinary(t, "x11vnc")

	// 1. Start isolated Xvfb on dynamic display via -displayfd 1
	xvfbCmd := exec.CommandContext(ctx, "Xvfb", "-displayfd", "1", "-screen", "0", "800x600x24", "-nolisten", "tcp")
	stdout, err := xvfbCmd.StdoutPipe()
	if err != nil {
		t.Fatalf("failed to create Xvfb stdout pipe: %v", err)
	}
	xvfbCmd.Stderr = io.Discard

	if err := xvfbCmd.Start(); err != nil {
		t.Fatalf("failed to start Xvfb: %v", err)
	}

	displayScanner := bufio.NewScanner(stdout)
	if !displayScanner.Scan() {
		_ = xvfbCmd.Process.Kill()
		t.Fatalf("failed to read displayfd from Xvfb: %v", displayScanner.Err())
	}
	dispNum := strings.TrimSpace(displayScanner.Text())
	display := ":" + dispNum

	// 2. Allocate an unused TCP port for x11vnc
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = xvfbCmd.Process.Kill()
		t.Fatalf("failed to allocate free port for x11vnc: %v", err)
	}
	vncPort := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	// 3. Start x11vnc attached to our isolated Xvfb display
	vncCmd := exec.CommandContext(ctx, "x11vnc",
		"-display", display,
		"-nopw",
		"-localhost",
		"-rfbport", strconv.Itoa(vncPort),
		"-forever",
		"-shared",
	)
	vncCmd.Stdout = io.Discard
	vncCmd.Stderr = io.Discard
	if err := vncCmd.Start(); err != nil {
		_ = xvfbCmd.Process.Kill()
		t.Fatalf("failed to start x11vnc: %v", err)
	}

	cleanup := func() {
		if vncCmd.Process != nil {
			_ = vncCmd.Process.Kill()
			_ = vncCmd.Wait()
		}
		if xvfbCmd.Process != nil {
			_ = xvfbCmd.Process.Kill()
			_ = xvfbCmd.Wait()
		}
		// Clean up any X11 socket left in /tmp/.X11-unix/X<dispNum>
		_ = os.Remove(filepath.Join("/tmp/.X11-unix", "X"+dispNum))
	}

	// 4. Wait for x11vnc TCP readiness with bounded polling
	ready := false
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", vncPort), 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			ready = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !ready {
		cleanup()
		t.Fatalf("x11vnc failed to become ready on 127.0.0.1:%d within 5 seconds", vncPort)
	}

	return vncPort, cleanup
}

func TestGoldenFlowPhase5Desktop(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	vncPort, vncCleanup := startXvfbAndVNC(t, ctx)
	t.Cleanup(vncCleanup)

	// Set up server pointing at real x11vnc fixture
	srv, pairings := newBootstrapServer(t)
	srv.cfg.VNCPort = vncPort

	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()

	bearerToken := testBearerToken(t, srv, pairings)

	// Step C: POST /v1/desktop/sessions to issue ticket
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/v1/desktop/sessions", nil)
	if err != nil {
		t.Fatalf("failed to build POST /v1/desktop/sessions request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+bearerToken)

	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("POST /v1/desktop/sessions request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200 OK from /v1/desktop/sessions, got %d: %s", resp.StatusCode, string(body))
	}

	var sessionResp protocol.DesktopSessionResponse
	if err := json.NewDecoder(resp.Body).Decode(&sessionResp); err != nil {
		t.Fatalf("failed to decode desktop session response: %v", err)
	}

	// Validate ticket format and payload properties
	if sessionResp.Ticket == "" {
		t.Fatal("expected non-empty ticket")
	}
	rawTicket, err := base64.RawURLEncoding.DecodeString(sessionResp.Ticket)
	if err != nil || len(rawTicket) != 32 {
		t.Fatalf("expected 32-byte base64url ticket, decoded %d bytes (err: %v)", len(rawTicket), err)
	}

	ttlRemaining := time.Until(sessionResp.ExpiresAt)
	if ttlRemaining < 30*time.Second || ttlRemaining > 10*time.Minute {
		t.Fatalf("expected reasonable expiration ~5m, got expiresAt=%v (ttl remaining: %v)", sessionResp.ExpiresAt, ttlRemaining)
	}

	if !strings.Contains(sessionResp.WSUrl, "/v1/ws/rfb?ticket="+sessionResp.Ticket) {
		t.Fatalf("expected wsUrl to contain /v1/ws/rfb?ticket=..., got %s", sessionResp.WSUrl)
	}
	if strings.Contains(sessionResp.WSUrl, bearerToken) || strings.Contains(sessionResp.WSUrl, "token=") {
		t.Fatalf("expected wsUrl to NOT contain bearer token, got %s", sessionResp.WSUrl)
	}

	// Step D: Dial WebSocket to /v1/ws/rfb?ticket=<ticket>
	wsEndpoint := ts.URL + "/v1/ws/rfb?ticket=" + sessionResp.Ticket
	wsConn, _, err := websocket.Dial(ctx, wsEndpoint, &websocket.DialOptions{
		HTTPClient: ts.Client(),
	})
	if err != nil {
		t.Fatalf("failed to dial RFB WebSocket: %v", err)
	}
	defer wsConn.CloseNow()

	stream := &wsStream{ctx: ctx, conn: wsConn}

	// 1. ProtocolVersion handshake
	verBuf := make([]byte, 12)
	if _, err := io.ReadFull(stream, verBuf); err != nil {
		t.Fatalf("failed to read RFB ProtocolVersion: %v", err)
	}
	if !bytes.HasPrefix(verBuf, []byte("RFB 003.00")) {
		t.Fatalf("unexpected server protocol version string: %q", string(verBuf))
	}
	// Reply with RFB 003.008\n
	if _, err := stream.Write([]byte("RFB 003.008\n")); err != nil {
		t.Fatalf("failed to send ProtocolVersion: %v", err)
	}

	// 2. Security handshake
	secCountBuf := make([]byte, 1)
	if _, err := io.ReadFull(stream, secCountBuf); err != nil {
		t.Fatalf("failed to read security types count: %v", err)
	}
	numSec := int(secCountBuf[0])
	if numSec == 0 {
		t.Fatal("server offered 0 security types (connection rejected by VNC)")
	}
	secTypes := make([]byte, numSec)
	if _, err := io.ReadFull(stream, secTypes); err != nil {
		t.Fatalf("failed to read security types: %v", err)
	}
	hasNone := false
	for _, st := range secTypes {
		if st == 1 { // 1 = None
			hasNone = true
			break
		}
	}
	if !hasNone {
		t.Fatalf("server did not offer 'None' (type 1) security: %v", secTypes)
	}
	// Select None (1)
	if _, err := stream.Write([]byte{1}); err != nil {
		t.Fatalf("failed to send selected security type: %v", err)
	}

	// 3. SecurityResult (4 bytes in RFB 3.8, 0 = OK)
	secResultBuf := make([]byte, 4)
	if _, err := io.ReadFull(stream, secResultBuf); err != nil {
		t.Fatalf("failed to read SecurityResult: %v", err)
	}
	secResult := binary.BigEndian.Uint32(secResultBuf)
	if secResult != 0 {
		t.Fatalf("expected SecurityResult 0 (OK), got %d", secResult)
	}

	// 4. ClientInit: shared flag = 1
	if _, err := stream.Write([]byte{1}); err != nil {
		t.Fatalf("failed to send ClientInit: %v", err)
	}

	// 5. ServerInit (24 bytes header + name)
	serverInitHdr := make([]byte, 24)
	if _, err := io.ReadFull(stream, serverInitHdr); err != nil {
		t.Fatalf("failed to read ServerInit header: %v", err)
	}
	fbWidth := binary.BigEndian.Uint16(serverInitHdr[0:2])
	fbHeight := binary.BigEndian.Uint16(serverInitHdr[2:4])
	bpp := serverInitHdr[4]
	nameLen := binary.BigEndian.Uint32(serverInitHdr[20:24])

	if fbWidth != 800 || fbHeight != 600 {
		t.Fatalf("expected 800x600 framebuffer from Xvfb, got %dx%d", fbWidth, fbHeight)
	}
	if bpp != 32 && bpp != 24 && bpp != 16 {
		t.Fatalf("unexpected bits-per-pixel: %d", bpp)
	}

	nameBuf := make([]byte, nameLen)
	if _, err := io.ReadFull(stream, nameBuf); err != nil {
		t.Fatalf("failed to read desktop name: %v", err)
	}

	// 6. SetEncodings: Raw encoding 0
	setEncodingsMsg := []byte{
		2,          // message-type: SetEncodings
		0,          // padding
		0, 1,       // number-of-encodings: 1
		0, 0, 0, 0, // encoding: 0 (Raw)
	}
	if _, err := stream.Write(setEncodingsMsg); err != nil {
		t.Fatalf("failed to write SetEncodings: %v", err)
	}

	// 7. FramebufferUpdateRequest: non-incremental, x=0, y=0, w=800, h=600
	fbReqMsg := []byte{
		3,                              // message-type: FramebufferUpdateRequest
		0,                              // incremental: 0 (full frame)
		0, 0,                           // x: 0
		0, 0,                           // y: 0
		byte(fbWidth >> 8), byte(fbWidth),   // width
		byte(fbHeight >> 8), byte(fbHeight), // height
	}
	if _, err := stream.Write(fbReqMsg); err != nil {
		t.Fatalf("failed to write FramebufferUpdateRequest: %v", err)
	}

	// 8. Read FramebufferUpdate message
	fbUpdateHdr := make([]byte, 4)
	if _, err := io.ReadFull(stream, fbUpdateHdr); err != nil {
		t.Fatalf("failed to read FramebufferUpdate header: %v", err)
	}
	if fbUpdateHdr[0] != 0 { // message-type 0 = FramebufferUpdate
		t.Fatalf("expected message-type 0 (FramebufferUpdate), got %d", fbUpdateHdr[0])
	}
	numRects := binary.BigEndian.Uint16(fbUpdateHdr[2:4])
	if numRects == 0 {
		t.Fatal("expected at least 1 rectangle in FramebufferUpdate")
	}

	// Read first rectangle header (12 bytes)
	rectHdr := make([]byte, 12)
	if _, err := io.ReadFull(stream, rectHdr); err != nil {
		t.Fatalf("failed to read rectangle header: %v", err)
	}
	rectW := binary.BigEndian.Uint16(rectHdr[4:6])
	rectH := binary.BigEndian.Uint16(rectHdr[6:8])
	rectEnc := binary.BigEndian.Uint32(rectHdr[8:12])

	if rectW == 0 || rectH == 0 {
		t.Fatalf("expected non-zero rectangle dimensions, got %dx%d", rectW, rectH)
	}
	if rectEnc != 0 {
		t.Fatalf("expected Raw encoding 0, got %d", rectEnc)
	}

	// Read rectangle pixel data
	bytesPerPixel := int(bpp) / 8
	if bytesPerPixel == 0 {
		bytesPerPixel = 1
	}
	pixelDataLen := int(rectW) * int(rectH) * bytesPerPixel
	pixelData := make([]byte, pixelDataLen)
	if _, err := io.ReadFull(stream, pixelData); err != nil {
		t.Fatalf("failed to read %d pixel bytes: %v", pixelDataLen, err)
	}

	// 9. Send pointer input event: type 5, mask 0, x=100, y=100
	pointerMsg := []byte{
		5,    // message-type: PointerEvent
		0,    // button-mask
		0, 100, // x: 100
		0, 100, // y: 100
	}
	if _, err := stream.Write(pointerMsg); err != nil {
		t.Fatalf("failed to send pointer input event: %v", err)
	}

	// 10. Clean close
	_ = wsConn.Close(websocket.StatusNormalClosure, "test completed")

	// Step E: Verify ticket reuse rejection
	reuseReq, err := http.NewRequestWithContext(ctx, http.MethodGet, wsEndpoint, nil)
	if err != nil {
		t.Fatalf("failed to build reuse request: %v", err)
	}
	reuseResp, err := ts.Client().Do(reuseReq)
	if err != nil {
		// Connection failed/rejected is valid
	} else {
		defer reuseResp.Body.Close()
		if reuseResp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected 401 Unauthorized for reused ticket, got %d", reuseResp.StatusCode)
		}
	}
}

func TestRequireBinaryDesktopPhase5(t *testing.T) {
	if os.Getenv("TEST_REQUIRE_BINARY_DESKTOP_SUB") == "1" {
		requireBinary(t, "nonexistent_binary_phase5_12345")
		return
	}

	// 1. Exists
	p := requireBinary(t, "go")
	if p == "" {
		t.Fatal("expected non-empty path for 'go'")
	}

	// 2. Non-strict skips
	t.Run("NonStrictSkips", func(t *testing.T) {
		t.Setenv("AGENTICREMOTE_STRICT_INTEGRATION", "")
		requireBinary(t, "nonexistent_binary_phase5_12345")
	})

	// 3. Strict fails
	t.Run("StrictFails", func(t *testing.T) {
		cmd := exec.Command(os.Args[0], "-test.run=^TestRequireBinaryDesktopPhase5$")
		cmd.Env = append(os.Environ(), "TEST_REQUIRE_BINARY_DESKTOP_SUB=1", "AGENTICREMOTE_STRICT_INTEGRATION=1")
		out, err := cmd.CombinedOutput()
		if err == nil {
			t.Fatalf("expected command to fail when AGENTICREMOTE_STRICT_INTEGRATION=1, but passed. Output: %s", string(out))
		}
		if !strings.Contains(string(out), "AGENTICREMOTE_STRICT_INTEGRATION=1: nonexistent_binary_phase5_12345 binary required but not found in PATH") {
			t.Fatalf("unexpected output: %s", string(out))
		}
	})
}
