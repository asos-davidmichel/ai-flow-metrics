# AI Token Usage & Cost Estimates

Each full pipeline run makes **two AI calls** — one to configure the board, one to generate chart insights.

## Token usage per run

| Step | Input tokens | Output tokens |
|------|-------------|---------------|
| Step 3 — Configure board | ~41,000 | ~300 |
| Step 8 — Interpret metrics | ~16,000 | ~14,000 |
| **Total** | **~57,000** | **~14,300** |

## Cost per run

| Model | Cost |
|-------|------|
| GPT-4o-mini | ~$0.01 |
| GPT-4o | ~$0.15 |
| Claude Sonnet | ~$0.40 |

## Notes

- Running weekly ≈ $1.60/month on Claude Sonnet; monthly ≈ $0.40/month.
- **Scheduled runs** (GitHub Actions / `--auto`) are slightly cheaper — Step 3 (configure board) is skipped because `config.json` is reused from the previous run, saving ~$0.15 per run on Claude Sonnet.
