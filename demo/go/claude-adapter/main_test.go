package main

// Tests run against a fake Messages API (httptest) with a dummy key: no real credentials, no billed calls.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
)

type fakeAPI struct {
	mu      sync.Mutex
	body    map[string]any
	headers http.Header
	path    string
	status  int
	reply   string
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.body, f.headers, f.path = nil, r.Header.Clone(), r.URL.Path
	_ = json.Unmarshal(raw, &f.body)
	w.Header().Set("content-type", "application/json")
	if f.status != 0 && f.status != 200 {
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`))
		return
	}
	_, _ = w.Write([]byte(f.reply))
}

const okReply = `{"id":"msg_test","type":"message","role":"assistant","model":"claude-opus-5-5",
 "content":[{"type":"thinking","thinking":"","signature":"sig"},{"type":"text","text":"{\"intent\":\"set_temperature\",\"temperature\":22,\"item\":null}"}],
 "stop_reason":"end_turn","stop_sequence":null,
 "usage":{"input_tokens":21,"output_tokens":38,"cache_read_input_tokens":1500,"cache_creation_input_tokens":0}}`

// isolateCredentials hides any credential in the developer's environment (env vars, `ant auth login` profile under
// HOME) so tests only ever send the dummy key, and only to the local fake server.
func isolateCredentials(t *testing.T) {
	t.Helper()
	for _, k := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_BASE_URL",
		"ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE"} {
		if v, ok := os.LookupEnv(k); ok {
			os.Unsetenv(k)
			t.Cleanup(func() { os.Setenv(k, v) })
		}
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
}

func newAdapter(t *testing.T, f *fakeAPI) (*Adapter, *httptest.Server) {
	t.Helper()
	isolateCredentials(t)
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	client := anthropic.NewClient(option.WithBaseURL(srv.URL), option.WithAPIKey("test-dummy-key"), option.WithMaxRetries(0))
	return &Adapter{Client: client, Models: map[string]string{"large": "claude-opus-5-5", "medium": "claude-sonnet-5-5", "small": "claude-haiku-5-5"}}, srv
}

// the payload guest-assistant builds, after the gateway set tier + effort
const intentPayload = `{"model":"large","system":[{"type":"text","text":"You are the HotelGrid concierge intent classifier.","cache_control":{"type":"ephemeral"}}],
 "messages":[{"role":"user","content":"ช่วยตั้งแอร์ 22 องศาค่ะ"}],"max_tokens":64,"metadata":{"task":"intent"},"output_config":{"effort":"high"}}`

func post(t *testing.T, a *Adapter, body string) (int, map[string]any) {
	t.Helper()
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	res, err := http.Post(srv.URL+"/v1/messages", "application/json", bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestIntentRequestMapsToMessagesAPI(t *testing.T) {
	f := &fakeAPI{reply: okReply}
	a, _ := newAdapter(t, f)
	status, out := post(t, a, intentPayload)
	if status != 200 {
		t.Fatalf("status %d: %v", status, out)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.path != "/v1/messages" {
		t.Errorf("path %s", f.path)
	}
	// never print header values: an ambient credential from the developer's environment could be among them
	var names []string
	for k := range f.headers {
		names = append(names, k)
	}
	// SDK v2 sends the API key as "Authorization: Bearer <key>"
	if !strings.Contains(f.headers.Get("anthropic-beta"), "server-side-fallback-2026-07-01") || f.headers.Get("authorization") != "Bearer test-dummy-key" {
		t.Errorf("headers: beta=%q, auth is the dummy key: %v, header names: %v", f.headers.Get("anthropic-beta"), f.headers.Get("authorization") == "Bearer test-dummy-key", names)
	}
	b := f.body
	if b["model"] != "claude-opus-5-5" || b["fallbacks"] != "default" || b["max_tokens"].(float64) != minMaxTokens {
		t.Errorf("model/fallbacks/max_tokens: %v %v %v", b["model"], b["fallbacks"], b["max_tokens"])
	}
	if oc, _ := b["output_config"].(map[string]any); oc["effort"] != "high" {
		t.Errorf("output_config %v", b["output_config"])
	}
	sys, _ := b["system"].([]any)
	if len(sys) != 1 || sys[0].(map[string]any)["cache_control"].(map[string]any)["type"] != "ephemeral" {
		t.Errorf("system cache_control lost: %v", b["system"])
	}
	if _, ok := b["metadata"]; ok {
		t.Errorf("demo metadata must not be sent to the API: %v", b["metadata"])
	}
	if _, ok := b["thinking"]; ok {
		t.Errorf("thinking should be left unset (always on for current models): %v", b["thinking"])
	}
	msgs, _ := b["messages"].([]any)
	if len(msgs) != 1 || msgs[0].(map[string]any)["role"] != "user" {
		t.Errorf("messages %v", b["messages"])
	}
	// response: text only (thinking dropped), usage with cache fields, provider label
	content := out["content"].([]any)
	if len(content) != 1 || !strings.Contains(content[0].(map[string]any)["text"].(string), `"intent":"set_temperature"`) {
		t.Errorf("content %v", content)
	}
	u := out["usage"].(map[string]any)
	if u["input_tokens"].(float64) != 21 || u["output_tokens"].(float64) != 38 || u["cache_read_input_tokens"].(float64) != 1500 {
		t.Errorf("usage %v", u)
	}
	if out["_provider"] != "anthropic" || out["model"] != "claude-opus-5-5" {
		t.Errorf("provider/model %v %v", out["_provider"], out["model"])
	}
}

func TestHaikuTierHasNoServerSideFallback(t *testing.T) {
	f := &fakeAPI{reply: strings.Replace(okReply, "claude-opus-5-5", "claude-haiku-5-5", 1)}
	a, _ := newAdapter(t, f)
	status, _ := post(t, a, strings.Replace(intentPayload, `"model":"large"`, `"model":"small"`, 1))
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.body["model"] != "claude-haiku-5-5" || f.body["fallbacks"] != nil || strings.Contains(f.headers.Get("anthropic-beta"), "server-side-fallback") {
		t.Errorf("haiku request: model=%v fallbacks=%v beta=%q", f.body["model"], f.body["fallbacks"], f.headers.Get("anthropic-beta"))
	}
}

func TestRefusalBecomesSafeParseableAnswer(t *testing.T) {
	f := &fakeAPI{reply: `{"id":"msg_r","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],
	 "stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"x"},"stop_sequence":null,
	 "usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}`}
	a, _ := newAdapter(t, f)
	_, out := post(t, a, intentPayload)
	text := out["content"].([]any)[0].(map[string]any)["text"].(string)
	if out["stop_reason"] != "refusal" || text != `{"intent":"other","temperature":null,"item":null}` {
		t.Errorf("refusal mapping: %v %q", out["stop_reason"], text)
	}
}

func TestAPIErrorStatusPassesThroughWithoutLeakingDetails(t *testing.T) {
	f := &fakeAPI{status: 401}
	a, _ := newAdapter(t, f)
	status, out := post(t, a, intentPayload)
	msg := out["error"].(map[string]any)["message"].(string)
	if status != 401 || msg != "Claude API returned 401" {
		t.Errorf("status %d msg %q", status, msg)
	}
	if s, _ := post(t, a, `{"model":"large","messages":[]}`); s != 400 {
		t.Errorf("empty messages should be 400, got %d", s)
	}
}
