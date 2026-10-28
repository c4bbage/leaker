package privacy

import (
	"context"
	"strings"
	"testing"
)

type mockModel struct {
	target string
	label  string
}

func (m *mockModel) Find(ctx context.Context, texts []string) ([][]Found, error) {
	out := make([][]Found, len(texts))
	for i, text := range texts {
		idx := 0
		for {
			pos := strings.Index(text[idx:], m.target)
			if pos < 0 {
				break
			}
			start := idx + pos
			end := start + len(m.target)
			out[i] = append(out[i], Found{
				Start: start,
				End:   end,
				Label: m.label,
				Score: 0.95,
			})
			idx = end
		}
	}
	return out, nil
}

func TestSession_ModelDrivenRedactionAndRestore(t *testing.T) {
	ctx := context.Background()

	// 模拟本地模型识别出无格式的人名 "欧阳修" 和公司代号 "ProjectNebula"
	p, err := New(Config{
		Model: &mockModel{target: "欧阳修", label: "private_person"},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	session := p.NewSession()
	defer session.Close()

	input := "请帮我联系欧阳修并发送邮件"
	masked, hits, err := session.ProtectText(ctx, input)
	if err != nil {
		t.Fatalf("ProtectText: %v", err)
	}
	if len(hits) == 0 {
		t.Fatalf("expected model hit")
	}
	if strings.Contains(masked, "欧阳修") {
		t.Fatalf("model entity leaked in masked text: %s", masked)
	}

	restored, err := session.RestoreText(ctx, masked)
	if err != nil {
		t.Fatalf("RestoreText: %v", err)
	}
	if restored != input {
		t.Fatalf("restored text mismatch:\nwant: %s\ngot:  %s", input, restored)
	}
}
