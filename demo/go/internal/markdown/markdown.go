// Package markdown ports platform/lib/markdown.mjs: the tiny renderer used for impact and reconciliation reports
// (headings, tables, lists, code, bold, inline code, links). Output must match the Node version byte for byte.
package markdown

import (
	"regexp"
	"strings"
)

var (
	codeRe   = regexp.MustCompile("`([^`]+)`")
	boldRe   = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	linkRe   = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
	headRe   = regexp.MustCompile(`^#{1,4} `)
	hashesRe = regexp.MustCompile(`^#+`)
	ulRe     = regexp.MustCompile(`^\s*[-*] `)
	olRe     = regexp.MustCompile(`^\d+\. `)
	escaper  = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
)

func esc(s string) string { return escaper.Replace(s) }

func inline(s string) string {
	s = esc(s)
	s = codeRe.ReplaceAllString(s, "<code>${1}</code>")
	s = boldRe.ReplaceAllString(s, "<strong>${1}</strong>")
	return linkRe.ReplaceAllString(s, `<a href="${2}">${1}</a>`)
}

func cells(row string) []string {
	parts := strings.Split(row, "|")
	if len(parts) < 2 {
		return nil
	}
	parts = parts[1 : len(parts)-1]
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func ToHTML(md string) string {
	lines := strings.Split(md, "\n")
	var out []string
	i := 0
	for i < len(lines) {
		l := lines[i]
		switch {
		case strings.HasPrefix(l, "```"):
			var buf []string
			i++
			for i < len(lines) && !strings.HasPrefix(lines[i], "```") {
				buf = append(buf, lines[i])
				i++
			}
			i++
			out = append(out, "<pre><code>"+esc(strings.Join(buf, "\n"))+"</code></pre>")
		case headRe.MatchString(l):
			n := len(hashesRe.FindString(l))
			h := string(rune('0' + n))
			out = append(out, "<h"+h+">"+inline(l[n+1:])+"</h"+h+">")
			i++
		case strings.HasPrefix(l, "|"):
			var rows []string
			for i < len(lines) && strings.HasPrefix(lines[i], "|") {
				rows = append(rows, lines[i])
				i++
			}
			var b strings.Builder
			b.WriteString(`<div class="table-wrap"><table><thead><tr>`)
			for _, h := range cells(rows[0]) {
				b.WriteString("<th>" + inline(h) + "</th>")
			}
			b.WriteString("</tr></thead><tbody>")
			if len(rows) > 2 {
				for _, r := range rows[2:] {
					b.WriteString("<tr>")
					for _, c := range cells(r) {
						b.WriteString("<td>" + inline(c) + "</td>")
					}
					b.WriteString("</tr>")
				}
			}
			b.WriteString("</tbody></table></div>")
			out = append(out, b.String())
		case ulRe.MatchString(l):
			var b strings.Builder
			b.WriteString("<ul>")
			for i < len(lines) && ulRe.MatchString(lines[i]) {
				b.WriteString("<li>" + inline(ulRe.ReplaceAllString(lines[i], "")) + "</li>")
				i++
			}
			b.WriteString("</ul>")
			out = append(out, b.String())
		case olRe.MatchString(l):
			var b strings.Builder
			b.WriteString("<ol>")
			for i < len(lines) && olRe.MatchString(lines[i]) {
				b.WriteString("<li>" + inline(olRe.ReplaceAllString(lines[i], "")) + "</li>")
				i++
			}
			b.WriteString("</ol>")
			out = append(out, b.String())
		case strings.HasPrefix(l, "> "):
			out = append(out, "<blockquote>"+inline(l[2:])+"</blockquote>")
			i++
		case strings.TrimSpace(l) == "":
			i++
		default:
			out = append(out, "<p>"+inline(l)+"</p>")
			i++
		}
	}
	return strings.Join(out, "\n")
}
