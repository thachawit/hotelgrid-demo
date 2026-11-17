// Package pricing mirrors platform/lib/pricing.mjs (config/pricing.json, batch discount).
package pricing

import "hotelgrid/internal/config"

type ModelPrice struct {
	RefModel          string  `json:"refModel"`
	InputPerMTok      float64 `json:"inputPerMTok"`
	OutputPerMTok     float64 `json:"outputPerMTok"`
	CacheReadPerMTok  float64 `json:"cacheReadPerMTok"`
	CacheWritePerMTok float64 `json:"cacheWritePerMTok"`
}

type Pricing struct {
	BatchDiscount float64               `json:"batchDiscount"`
	Models        map[string]ModelPrice `json:"models"`
}

type Usage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

func Load(root string) (Pricing, error) {
	var p Pricing
	return p, config.Read(root, "config/pricing.json", &p)
}

// PriceCall mirrors pricing.mjs priceCall; unknown tier → 0.
func (p Pricing) PriceCall(model string, u Usage, batch bool) float64 {
	m, ok := p.Models[model]
	if !ok {
		return 0
	}
	usd := (float64(u.InputTokens)*m.InputPerMTok + float64(u.OutputTokens)*m.OutputPerMTok +
		float64(u.CacheReadInputTokens)*m.CacheReadPerMTok + float64(u.CacheCreationInputTokens)*m.CacheWritePerMTok) / 1e6
	if batch {
		return usd * p.BatchDiscount
	}
	return usd
}

// TierOf maps a provider model id (e.g. claude-opus-5-5) back to the demo tier (large/medium/small).
func (p Pricing) TierOf(refModel string) string {
	for tier, m := range p.Models {
		if m.RefModel == refModel {
			return tier
		}
	}
	return ""
}
