Bad news on the most important part first: **your Claude subscription cannot fund an external app.** A paid Claude subscription (Pro/Max) doesn't include access to the Claude API — API usage is billed separately through the Console. Subscription tokens only work inside Anthropic's own surfaces (claude.ai, Claude Code), and Anthropic blocked third-party harnesses from using subscription limits as of April 2026. Wiring your site to your subscription would be both unsupported and a ban risk.

The consolation: this workload is nearly free anyway. One parse ≈ 300 input + 120 output tokens on Haiku ≈ 0.1 cent. Five logs a day ≈ **under €0.20/month**. Set a €5/month spend limit in the Console and forget about it.

**Funding options, rated for your case:**
- API key, pay-as-you-go: 6/7 — legitimate, ~cents/month, works on GitHub Pages
- Subscription via OAuth token hacks: 1/7 — blocked, ToS violation
- Keep it as a Claude artifact: 3/7 — the only sanctioned subscription route, but you already find it inconvenient

**Architecture** (static, no backend, no database):

```
repo/
  index.html      # single file: UI + logic
```

- All state in `localStorage`: `protein.days` (one JSON object keyed by date), `protein.goal`, `protein.apiKey`
- First run: settings panel asks for your API key → stored in localStorage only. The key never appears in the repo, so the public site is safe; visitors would need their own key.
- The browser calls the API directly. This is officially supported: Anthropic enabled CORS via the `anthropic-dangerous-direct-browser-access: true` header, intended exactly for "bring your own API key" client-side apps.

Core call:

```javascript
const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": localStorage.getItem("protein.apiKey"),
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
  },
  body: JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    messages: [{ role: "user", content: PARSE_PROMPT + userText }],
  }),
});
```

Paste-ready spec for Claude Code:

```
Build a single-file protein tracker (index.html, vanilla JS, no build step) for GitHub Pages.

Input: one text field. User types fuzzy food descriptions ("4 fried eggs, 2 spoons sauerkraut").
On submit, call the Anthropic Messages API directly from the browser (headers: x-api-key,
anthropic-version 2023-06-01, anthropic-dangerous-direct-browser-access: true,
model claude-haiku-4-5-20251001). Prompt Claude to return ONLY a raw JSON array:
[{"name": str, "amount": str, "protein_g": int}], metric portions, whole grams.
Strip markdown fences before JSON.parse; on failure show "Couldn't parse — rephrase."

State in localStorage:
- protein.apiKey (string; settings panel on first run, never hardcoded)
- protein.goal (int, default 120, editable)
- protein.days: {"YYYY-MM-DD": [{id, name, amount, protein}]}

UI (mobile-first): today's total in g vs goal, progress bar, item list with delete,
last-7-days mini bar chart, grams only. Nutrition-label aesthetic: white, black heavy
rules, bold grotesque type.

Guards: disable submit while pending; try/catch around fetch and parse;
show API error messages; Enter submits.
```

Deploy: push → repo Settings → Pages → main branch. Done. If you ever want the key off your device (e.g. to use it from multiple browsers without re-entering), the upgrade path is a ~20-line Cloudflare Worker holding the key — still no database, still free.
