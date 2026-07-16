package security

import "testing"

func TestCertificateHostsIncludesPublicDNS(t *testing.T) {
	ips, dnsNames := certificateHosts("0.0.0.0:8765", "https://tail-host.ts.net:8765")
	for _, ip := range ips {
		if got := ip.String(); got == "0.0.0.0" {
			t.Fatal("expected unspecified listen address to be excluded")
		}
	}
	if len(dnsNames) != 1 || dnsNames[0] != "tail-host.ts.net" {
		t.Fatalf("unexpected dns names: %#v", dnsNames)
	}
}

func TestCertificateHostsDeduplicatesPublicIP(t *testing.T) {
	ips, _ := certificateHosts("127.0.0.1:8765", "https://100.64.1.2:8765")
	count := 0
	for _, ip := range ips {
		if ip.String() == "100.64.1.2" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected public ip once, got %d in %#v", count, ips)
	}
}
