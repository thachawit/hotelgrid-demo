// claude-adapter: OPTIONAL real-Claude provider for the LLM gateway (LLM_PROVIDER=anthropic).
//
// The gateway sends guest-assistant calls (metadata.task "intent" or "reply") here instead of the simulator. This
// process translates the demo's request into a Messages API call through the official Go SDK
// (github.com/anthropics/anthropic-sdk-go/v2) and answers in the same shape the simulator uses, so the gateway's
// pricing, ledger rows and online accuracy work unchanged.
//
// It lives in its own Go module so the rest of the demo keeps zero Go-module dependencies. In production you would
// link the SDK straight into the gateway.
//
// Credentials: the SDK resolves them itself (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login`
// profile). This program never reads, logs or stores them. Every request it serves is billed by Anthropic.
//
//	go build -o claude-adapter . && ./claude-adapter -root <demo root>
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
)

// Tier → model id. Defaults follow config/pricing.json (refModel); see Adapter.Models.
var defaultModels = map[string]string{"large": "claude-opus-5-5", "medium": "claude-sonnet-5-5", "small": "claude-haiku-5-5"}

// Thinking is always on for the current models and counts against max_tokens; the demo's callers ask for 64–160
// tokens of visible output, so give the model room. Only tokens actually generated are billed.
const minMaxTokens = 4096

// Demo request: what the gateway forwards (simulator wire shape).
type demoRequest struct {
	Model    string          `json:"model"` // tier: large | medium | small
	System   json.RawMessage `json:"system"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
	MaxTokens int64 `json:"max_tokens"`
	Metadata  struct {
		Task string `json:"task"`
	} `json:"metadata"`
	OutputConfig struct {
		Effort string `json:"effort"`
	} `json:"output_config"`
}

type systemBlock struct {
	Text         string          `json:"text"`
	CacheControl json.RawMessage `json:"cache_control"`
}

// Demo response: simulator wire shape (text content only, usage with cache fields).
type demoUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

type demoResponse struct {
	ID         string           `json:"id"`
	Type       string           `json:"type"`
	Role       string           `json:"role"`
	Model      string           `json:"model"`
	Content    []map[string]any `json:"content"`
	StopReason string           `json:"stop_reason"`
	Usage      demoUsage        `json:"usage"`
	Provider   string           `json:"_provider"`
}

type Adapter struct {
	Client anthropic.Client
	Models map[string]string
}

func (a *Adapter) modelFor(tier string) string {
	if m, ok := a.Models[tier]; ok {
		return m
	}
	return a.Models["large"]
}

// BuildParams maps the demo request onto a Messages API request.
func (a *Adapter) BuildParams(req demoRequest) (anthropic.BetaMessageNewParams, error) {
	model := a.modelFor(req.Model)
	maxTokens := req.MaxTokens
	if maxTokens < minMaxTokens {
		maxTokens = minMaxTokens
	}
	p := anthropic.BetaMessageNewParams{Model: anthropic.Model(model), MaxTokens: maxTokens}

	// system: a string or a list of text blocks; keep cache_control so the static prefix is cached
	if len(req.System) > 0 && string(req.System) != "null" {
		var blocks []systemBlock
		if err := json.Unmarshal(req.System, &blocks); err != nil {
			var s string
			if err2 := json.Unmarshal(req.System, &s); err2 != nil {
				return p, fmt.Errorf("system must be a string or a list of text blocks")
			}
			blocks = []systemBlock{{Text: s}}
		}
		for _, b := range blocks {
			tb := anthropic.BetaTextBlockParam{Text: b.Text}
			if len(b.CacheControl) > 0 && string(b.CacheControl) != "null" {
				tb.CacheControl = anthropic.NewBetaCacheControlEphemeralParam()
			}
			p.System = append(p.System, tb)
		}
	}
	for _, m := range req.Messages {
		switch m.Role {
		case "user":
			p.Messages = append(p.Messages, anthropic.NewBetaUserMessage(anthropic.NewBetaTextBlock(m.Content)))
		case "assistant":
			p.Messages = append(p.Messages, anthropic.BetaMessageParam{OfAssistant: &anthropic.BetaAssistantMessageParam{
				Content: []anthropic.BetaContentBlockParamUnion{anthropic.NewBetaTextBlock(m.Content)}}})
		default:
			return p, fmt.Errorf("unsupported message role %q", m.Role)
		}
	}
	if len(p.Messages) == 0 {
		return p, errors.New("messages must not be empty")
	}
	// Effort per route (the gateway's route table). Claude Opus 5.5 / Haiku 5.5 default to medium, so always set it.
	effort := req.OutputConfig.Effort
	if effort == "" {
		effort = "medium"
	}
	p.OutputConfig = anthropic.BetaOutputConfigParam{Effort: anthropic.BetaOutputConfigEffort(effort)}
	// Server-side refusal fallback (beta) for the Opus and Sonnet tiers; Haiku has no server-side fallback.
	if !strings.HasPrefix(model, "claude-haiku") {
		p.Betas = []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01}
		p.Fallbacks = anthropic.BetaFallbacksParamOfDefault()
	}
	return p, nil
}

// Refusals keep the guest experience safe and parseable (same fallback texts as the Node adapter).
func refusalText(task string) string {
	if task == "intent" {
		return `{"intent":"other","temperature":null,"item":null}`
	}
	return "Sorry, I cannot help with that. A staff member will follow up."
}

func (a *Adapter) Call(ctx context.Context, req demoRequest) (int, any) {
	params, err := a.BuildParams(req)
	if err != nil {
		return 400, map[string]any{"type": "error", "error": map[string]any{"type": "invalid_request_error", "message": err.Error()}}
	}
	msg, err := a.Client.Beta.Messages.New(ctx, params)
	if err != nil {
		var apierr *anthropic.Error
		if errors.As(err, &apierr) {
			return apierr.StatusCode, map[string]any{"type": "error", "error": map[string]any{"type": "api_error", "message": fmt.Sprintf("Claude API returned %d", apierr.StatusCode)}}
		}
		return 502, map[string]any{"type": "error", "error": map[string]any{"type": "api_error", "message": "Claude API unreachable: " + err.Error()}}
	}
	var text strings.Builder
	for _, block := range msg.Content {
		if tb, ok := block.AsAny().(anthropic.BetaTextBlock); ok { // thinking blocks are dropped: callers parse the text
			text.WriteString(tb.Text)
		}
	}
	out := text.String()
	stop := string(msg.StopReason)
	if stop == "refusal" {
		out = refusalText(req.Metadata.Task)
	}
	return 200, demoResponse{
		ID: msg.ID, Type: "message", Role: "assistant", Model: string(msg.Model), StopReason: stop, Provider: "anthropic",
		Content: []map[string]any{{"type": "text", "text": out}},
		Usage: demoUsage{InputTokens: msg.Usage.InputTokens, OutputTokens: msg.Usage.OutputTokens,
			CacheReadInputTokens: msg.Usage.CacheReadInputTokens, CacheCreationInputTokens: msg.Usage.CacheCreationInputTokens},
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func (a *Adapter) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "service": "claude-adapter", "impl": "go", "models": a.Models})
	})
	mux.HandleFunc("POST /v1/messages", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		var req demoRequest
		if err == nil {
			err = json.Unmarshal(raw, &req)
		}
		if err != nil {
			writeJSON(w, 400, map[string]any{"type": "error", "error": map[string]any{"type": "invalid_request_error", "message": "invalid JSON body"}})
			return
		}
		status, body := a.Call(r.Context(), req)
		writeJSON(w, status, body)
	})
	return mux
}

func main() {
	root := flag.String("root", ".", "demo root (contains config/)")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("[claude-adapter] ")

	var topo struct {
		Ports map[string]int `json:"ports"`
	}
	var pricing struct {
		Models map[string]struct {
			RefModel string `json:"refModel"`
		} `json:"models"`
	}
	for path, v := range map[string]any{"config/topology.json": &topo, "config/pricing.json": &pricing} {
		b, err := os.ReadFile(filepath.Join(*root, path))
		if err == nil {
			err = json.Unmarshal(b, v)
		}
		if err != nil {
			log.Fatalf("reading %s: %v", path, err)
		}
	}
	models := map[string]string{}
	for tier, m := range defaultModels {
		models[tier] = m
	}
	for tier, p := range pricing.Models {
		if p.RefModel != "" {
			models[tier] = p.RefModel
		}
	}
	// The SDK resolves credentials from the environment / `ant auth login` profile; retries 429/5xx twice.
	a := &Adapter{Client: anthropic.NewClient(option.WithRequestTimeout(60 * time.Second)), Models: models}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	port := topo.Ports["claude-adapter"]
	srv := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", port), Handler: a.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Printf("listening on :%d — real Claude for guest-assistant intent/reply (%v); calls are billed by Anthropic", port, models)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
