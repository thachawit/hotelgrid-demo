// Package release is the release controller: per-site manifests, ring rollouts with continuous canary analysis,
// deploy freeze, manifest parity gate, and incident handling (culprit scoring, consumer-first rollback, recovery
// check, impact report, follow-up fix task). Port of deploy.mjs + canary.mjs + incidents.mjs.
package release

import "hotelgrid/internal/config"

type ManifestChange struct {
	Ts      int64   `json:"ts"`
	Site    string  `json:"site"`
	Service string  `json:"service"`
	From    string  `json:"from"`
	To      string  `json:"to"`
	Release *string `json:"release"`
	Actor   string  `json:"actor"`
	Reason  string  `json:"reason"`
}

type Freeze struct {
	Reason   string `json:"reason"`
	Since    int64  `json:"since"`
	Incident string `json:"incident"`
}

type Check struct {
	Kind     string         `json:"kind"`
	Service  string         `json:"service"`
	Enough   bool           `json:"enough"`
	Baseline map[string]any `json:"baseline"`
	Current  map[string]any `json:"current"`
	Z        *float64       `json:"z,omitempty"`
	Verdict  string         `json:"verdict"`
	TopError any            `json:"topError,omitempty"`
}

type Gate struct {
	Site         string   `json:"site"`
	At           int64    `json:"at"`
	Pass         bool     `json:"pass"`
	Failed       []string `json:"failed"`
	Insufficient bool     `json:"insufficient"`
	Final        bool     `json:"final"`
	Checks       []Check  `json:"checks"`
}

type ParityProblem struct {
	Site           string `json:"site"`
	Service        string `json:"service"`
	SiteVersion    string `json:"site_version"`
	StagingVersion string `json:"staging_version"`
}

type Parity struct {
	OK       bool            `json:"ok"`
	Problems []ParityProblem `json:"problems"`
}

type RingRec struct {
	Ring       int      `json:"ring"`
	Name       string   `json:"name"`
	Sites      []string `json:"sites"`
	Status     string   `json:"status"`
	Gates      []*Gate  `json:"gates"`
	Parity     *Parity  `json:"parity,omitempty"`
	DeployedAt int64    `json:"deployedAt,omitempty"`
	LastGate   *Gate    `json:"lastGate,omitempty"`
}

type Release struct {
	ID         string                `json:"id"`
	Name       string                `json:"name"`
	Services   config.OrderedStrings `json:"services"`
	Level      string                `json:"level"`
	Actor      string                `json:"actor"`
	WorkItemID *string               `json:"workItemId"`
	Status     string                `json:"status"` // rolling | complete | rolled-back | blocked:freeze | blocked:parity | failed
	StartedAt  int64                 `json:"startedAt"`
	FinishedAt int64                 `json:"finishedAt,omitempty"`
	Rings      []*RingRec            `json:"rings"`
	Settled    bool                  `json:"settled"` // rollout() has fully returned (incl. incident handling)
}

type RolloutReq struct {
	Name              string                `json:"name"`
	Services          config.OrderedStrings `json:"services"`
	Level             string                `json:"level"`
	Actor             string                `json:"actor"`
	WorkItemID        *string               `json:"workItemId"`
	ExtraPilotBakeSec float64               `json:"extraPilotBakeSec"`
	OverrideFreeze    bool                  `json:"overrideFreeze"`
}

// VersionMeta is the release-note metadata a version module exports (meta.breaking, meta.migrations).
type VersionMeta struct {
	Breaking   []string `json:"breaking"`
	Migrations []string `json:"migrations"`
}

type ServiceChange struct {
	Service string
	From    string
	To      string
	Meta    VersionMeta
}

type Rank struct {
	Service  string   `json:"service"`
	Version  *string  `json:"version"`
	Changed  bool     `json:"changed"`
	Score    float64  `json:"score"`
	Time     float64  `json:"time"`
	Path     float64  `json:"path"`
	Sig      int      `json:"sig"`
	Evidence []string `json:"evidence"`
}

type Loudest struct {
	Service    string `json:"service"`
	ErrorSpans int    `json:"errorSpans"`
}

type Culprit struct {
	FailingTraces int            `json:"failingTraces"`
	SampleTrace   *string        `json:"sampleTrace"`
	Loudest       *Loudest       `json:"loudest"`
	LeafCount     map[string]int `json:"leafCount"`
	Ranking       []Rank         `json:"ranking"`
	Confidence    float64        `json:"confidence"`
	TopMessage    *string        `json:"topMessage"`
}

type Step struct {
	Ts     int64  `json:"ts"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

type ImpactNumbers struct {
	EdgeFailed    int     `json:"edgeFailed"`
	EdgeTotal     int     `json:"edgeTotal"`
	Rooms         int     `json:"rooms"`
	Guests        int     `json:"guests"`
	HvacLost      int     `json:"hvacLost"`
	ChatsFailed   int     `json:"chatsFailed"`
	LLMCost       float64 `json:"llmCost"`
	LinkedSignals int     `json:"linkedSignals"`
}

type Report struct {
	Markdown   string        `json:"markdown,omitempty"`
	HTML       string        `json:"html,omitempty"`
	Numbers    ImpactNumbers `json:"numbers"`
	DriftNotes []string      `json:"driftNotes,omitempty"`
}

type Incident struct {
	ID            string   `json:"id"`
	Status        string   `json:"status"` // mitigating | mitigated | needs-human
	Site          string   `json:"site"`
	Release       string   `json:"release"`
	ReleaseName   string   `json:"releaseName"`
	DeployTs      int64    `json:"deployTs"`
	AnomalyStart  int64    `json:"anomalyStart"`
	DetectedAt    int64    `json:"detectedAt"`
	Steps         []Step   `json:"steps"`
	Gate          *Gate    `json:"gate"`
	Culprit       *Culprit `json:"culprit,omitempty"`
	RollbackOrder []string `json:"rollbackOrder,omitempty"`
	MitigatedAt   int64    `json:"mitigatedAt,omitempty"`
	RecoveredAt   int64    `json:"recoveredAt,omitempty"`
	Report        *Report  `json:"report,omitempty"`
	FixTask       string   `json:"fixTask,omitempty"`
}
