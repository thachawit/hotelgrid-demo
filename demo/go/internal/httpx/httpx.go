// Package httpx holds the small HTTP helpers every HotelGrid Go service shares. FetchJSON mirrors util.mjs fetchJson:
// it never returns an error; an unreachable upstream becomes status 599, a non-JSON body becomes {"_raw": text}.
package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

// Client is shared by all calls of one service (keep-alive pool to the other local services).
var Client = &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64, IdleConnTimeout: 30 * time.Second}}

type Upstream struct {
	Status int
	Raw    []byte         // response body as received
	Body   map[string]any // set when the body is a JSON object (or an error/_raw wrapper)
}

// Decode unmarshals the raw body into v (for array or typed responses).
func (u Upstream) Decode(v any) error { return json.Unmarshal(u.Raw, v) }

func (u Upstream) OK() bool { return u.Status == 200 }

func unreachable(msg string) Upstream {
	b := map[string]any{"error": "upstream unreachable: " + msg}
	raw, _ := json.Marshal(b)
	return Upstream{Status: 599, Raw: raw, Body: b}
}

func FetchJSON(ctx context.Context, method, url string, body any, headers map[string]string, timeout time.Duration) Upstream {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return unreachable(err.Error())
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return unreachable(err.Error())
	}
	req.Header.Set("content-type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := Client.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return unreachable("timeout")
		}
		return unreachable(err.Error())
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := Upstream{Status: res.StatusCode, Raw: raw}
	trimmed := bytes.TrimSpace(raw)
	switch {
	case len(trimmed) == 0:
		out.Body = map[string]any{}
	case trimmed[0] == '{':
		if json.Unmarshal(trimmed, &out.Body) != nil {
			out.Body = map[string]any{"_raw": string(raw)}
		}
	case trimmed[0] == '[':
		// arrays: use Decode; Body stays nil
	default:
		var v any
		if json.Unmarshal(trimmed, &v) != nil {
			out.Body = map[string]any{"_raw": string(raw)}
		}
	}
	return out
}

func Get(ctx context.Context, url string, timeout time.Duration) Upstream {
	return FetchJSON(ctx, "GET", url, nil, nil, timeout)
}

func Post(ctx context.Context, url string, body any, timeout time.Duration) Upstream {
	return FetchJSON(ctx, "POST", url, body, nil, timeout)
}

// WriteJSON writes v as a JSON response (same content type as util.mjs send()).
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false) // like JSON.stringify
	_ = enc.Encode(v)
}

// ReadJSON decodes a request body; an empty body leaves v untouched.
func ReadJSON(r *http.Request, v any) error {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	return json.Unmarshal(raw, v)
}

// Str and Map are tolerant accessors for decoded JSON.
func Str(v any) string { s, _ := v.(string); return s }

func Map(v any) map[string]any { m, _ := v.(map[string]any); return m }

// OrNil turns "" into JSON null (Node writes `x ?? null`).
func OrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}
