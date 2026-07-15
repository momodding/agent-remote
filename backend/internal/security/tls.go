package security

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type TLSMaterial struct {
	CertPath    string
	KeyPath     string
	Fingerprint string
	Certificate tls.Certificate
}

func EnsureTLS(stateDir, listenAddr string) (*TLSMaterial, error) {
	tlsDir := filepath.Join(stateDir, "tls")
	certPath := filepath.Join(tlsDir, "cert.pem")
	keyPath := filepath.Join(tlsDir, "key.pem")
	if err := os.MkdirAll(tlsDir, 0o755); err != nil {
		return nil, err
	}
	if _, err := os.Stat(certPath); err == nil {
		if _, err := os.Stat(keyPath); err != nil {
			return nil, err
		}
		return loadTLS(certPath, keyPath)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "agenticRemote"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(397 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageServerAuth,
		},
		BasicConstraintsValid: true,
		IPAddresses:           certificateIPs(listenAddr),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &priv.PublicKey, priv)
	if err != nil {
		return nil, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return nil, err
	}
	return loadTLS(certPath, keyPath)
}

func loadTLS(certPath, keyPath string) (*TLSMaterial, error) {
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, err
	}
	if len(cert.Certificate) == 0 {
		return nil, fmt.Errorf("certificate chain empty")
	}
	return &TLSMaterial{
		CertPath:    certPath,
		KeyPath:     keyPath,
		Fingerprint: Fingerprint(cert.Certificate[0]),
		Certificate: cert,
	}, nil
}

func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	hexText := strings.ToUpper(hex.EncodeToString(sum[:]))
	parts := make([]string, 0, len(hexText)/2)
	for i := 0; i < len(hexText); i += 2 {
		parts = append(parts, hexText[i:i+2])
	}
	return strings.Join(parts, ":")
}

func certificateIPs(listenAddr string) []net.IP {
	ips := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	host, _, err := net.SplitHostPort(listenAddr)
	if err == nil {
		if ip := net.ParseIP(host); ip != nil {
			ips = append(ips, ip)
		}
	}
	seen := map[string]bool{}
	out := make([]net.IP, 0, len(ips))
	for _, ip := range ips {
		if ip == nil {
			continue
		}
		key := ip.String()
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, ip)
	}
	return out
}
