package internal

import (
	"bufio"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// proxyURL returns the HTTP CONNECT proxy outbound traffic should use, or nil
// to connect directly. TUNWG_PROXY takes precedence; the conventional
// HTTPS_PROXY / ALL_PROXY variables are accepted as fallbacks so an existing
// proxy environment applies without extra configuration.
func proxyURL() *url.URL {
	for _, key := range []string{"TUNWG_PROXY", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"} {
		value := strings.TrimSpace(os.Getenv(key))
		if value == "" {
			continue
		}
		parsed, err := url.Parse(value)
		if err != nil || parsed.Host == "" {
			// Accept scheme-less values such as "127.0.0.1:7890"; url.Parse
			// reads those as scheme + opaque rather than host.
			parsed, err = url.Parse("http://" + strings.TrimPrefix(value, "//"))
			if err != nil || parsed.Host == "" {
				continue
			}
		}
		if parsed.Scheme == "" {
			parsed.Scheme = "http"
		}
		return parsed
	}
	return nil
}

// ProxyFunc adapts proxyURL for http.Transport.Proxy so API calls (for example
// the peer registration in addServerPeer) use the same egress as the relay
// data path.
func ProxyFunc(*http.Request) (*url.URL, error) {
	return proxyURL(), nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c bufferedConn) Read(b []byte) (int, error) {
	return c.reader.Read(b)
}

// DialTLS connects to addr (host:port) and completes the TLS handshake using
// cfg. When a proxy is configured the TCP connection is established through it
// with CONNECT, so long-lived tunnel traffic leaves through that egress too.
func DialTLS(addr string, cfg *tls.Config) (net.Conn, error) {
	raw, err := dialTCP(addr)
	if err != nil {
		return nil, err
	}
	conn := tls.Client(raw, cfg)
	if err := conn.Handshake(); err != nil {
		raw.Close()
		return nil, err
	}
	return conn, nil
}

func dialTCP(addr string) (net.Conn, error) {
	proxy := proxyURL()
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	if proxy == nil {
		return dialer.Dial("tcp", addr)
	}
	if proxy.Scheme != "http" && proxy.Scheme != "https" {
		return nil, fmt.Errorf("tunwg: unsupported proxy scheme %q (use http://host:port)", proxy.Scheme)
	}

	proxyAddr := proxy.Host
	if proxy.Port() == "" {
		port := "80"
		if proxy.Scheme == "https" {
			port = "443"
		}
		proxyAddr = net.JoinHostPort(proxy.Hostname(), port)
	}

	conn, err := dialer.Dial("tcp", proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("tunwg: dial proxy %s: %w", proxyAddr, err)
	}

	var req strings.Builder
	fmt.Fprintf(&req, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", addr, addr)
	if user := proxy.User; user != nil {
		password, _ := user.Password()
		credential := base64.StdEncoding.EncodeToString([]byte(user.Username() + ":" + password))
		fmt.Fprintf(&req, "Proxy-Authorization: Basic %s\r\n", credential)
	}
	req.WriteString("Proxy-Connection: Keep-Alive\r\n\r\n")

	if _, err := conn.Write([]byte(req.String())); err != nil {
		conn.Close()
		return nil, err
	}

	reader := bufio.NewReader(conn)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("tunwg: proxy CONNECT to %s: %w", proxyAddr, err)
	}
	if !strings.Contains(statusLine, " 200") {
		conn.Close()
		return nil, fmt.Errorf("tunwg: proxy %s rejected CONNECT %s: %s", proxyAddr, addr, strings.TrimSpace(statusLine))
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			conn.Close()
			return nil, fmt.Errorf("tunwg: proxy CONNECT headers: %w", err)
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}

	return bufferedConn{Conn: conn, reader: reader}, nil
}
