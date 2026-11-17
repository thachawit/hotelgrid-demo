package main

import (
	"testing"

	"hotelgrid/internal/config"
)

func TestCorpusLoadsAndRendersLikeNode(t *testing.T) {
	var c Corpus
	if err := config.Read("../../..", "platform/loadgen/corpus.json", &c); err != nil {
		t.Fatal(err)
	}
	if len(c.ChatTemplates) != 42 || len(c.Temps) != 9 || len(c.LineComplaints["setpoint"]["th"]) == 0 || len(c.StaffSlack) == 0 {
		t.Fatalf("corpus incomplete: %d templates, %d temps", len(c.ChatTemplates), len(c.Temps))
	}
	// String(22.5) = "22.5", String(20) = "20"
	if got := Render(ChatTemplate{Text: "Please set my room to {t} degrees"}, 22.5); got != "Please set my room to 22.5 degrees" {
		t.Errorf("render = %q", got)
	}
	if got := Render(ChatTemplate{Text: "ปรับแอร์เป็น {t} องศาให้หน่อยครับ"}, 20); got != "ปรับแอร์เป็น 20 องศาให้หน่อยครับ" {
		t.Errorf("render = %q", got)
	}
	if jsString(nil) != "null" || jsString(1204.0) != "1204" || jsString("G-1") != "G-1" {
		t.Errorf("jsString")
	}
}
