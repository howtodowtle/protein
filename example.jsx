import { useState, useEffect, useRef } from "react";

// ---------- date helpers ----------
const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
const dayKey = (d) => `protein:day:${fmt(d)}`;
const GOAL_KEY = "protein:goal";

// ---------- Claude parsing ----------
async function parseFood(text) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content:
            'You are a protein estimator. The input is a casual, fuzzy description of food someone ate (any language, vague amounts allowed). Split it into items and estimate grams of protein per item using realistic metric portions. Be sensible with fuzzy units ("a spoon", "a handful", "a bowl"). Respond with ONLY a raw JSON array, no markdown fences, no prose. Schema: [{"name": string, "amount": string, "protein_g": number}] . protein_g is a whole number >= 0 for the stated amount (not per unit). Keep names short and capitalized. Input: ' +
            JSON.stringify(text),
        },
      ],
    }),
  });
  const data = await res.json();
  const raw = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const clean = raw.replace(/```json|```/g, "").trim();
  const arr = JSON.parse(clean);
  if (!Array.isArray(arr)) throw new Error("bad shape");
  return arr
    .filter((x) => x && typeof x.name === "string")
    .map((x) => ({
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      name: x.name,
      amount: String(x.amount ?? ""),
      protein: Math.max(0, Math.round(Number(x.protein_g) || 0)),
    }));
}

// ---------- storage helpers ----------
async function loadJSON(key, fallback) {
  try {
    const r = await window.storage.get(key);
    return r ? JSON.parse(r.value) : fallback;
  } catch {
    return fallback;
  }
}

export default function ProteinTracker() {
  const [items, setItems] = useState([]);
  const [goal, setGoal] = useState(120);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [week, setWeek] = useState([]);
  const [editGoal, setEditGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState("120");
  const [ready, setReady] = useState(false);
  const inputRef = useRef(null);

  const total = items.reduce((s, i) => s + i.protein, 0);
  const pct = goal > 0 ? Math.min(100, (total / goal) * 100) : 0;
  const hit = goal > 0 && total >= goal;

  // ---------- initial load ----------
  useEffect(() => {
    (async () => {
      const g = await loadJSON(GOAL_KEY, 120);
      setGoal(g);
      setGoalDraft(String(g));
      const today = await loadJSON(dayKey(new Date()), []);
      setItems(today);
      setReady(true);
      refreshWeek(g);
    })();
  }, []);

  async function refreshWeek(goalVal) {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d);
    }
    const results = await Promise.all(
      days.map(async (d) => {
        const list = await loadJSON(dayKey(d), []);
        return {
          label: ["S", "M", "T", "W", "T", "F", "S"][d.getDay()],
          date: fmt(d),
          total: list.reduce((s, i) => s + i.protein, 0),
        };
      })
    );
    setWeek(results.map((r) => ({ ...r, goal: goalVal })));
  }

  async function persist(next) {
    setItems(next);
    try {
      await window.storage.set(dayKey(new Date()), JSON.stringify(next));
    } catch {
      setError("Saving failed — entry kept for this session only.");
    }
    refreshWeek(goal);
  }

  async function log() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      const parsed = await parseFood(text);
      if (parsed.length === 0) {
        setError("No food recognized — try rephrasing.");
      } else {
        setInput("");
        await persist([...items, ...parsed]);
      }
    } catch {
      setError("Couldn't parse that — try rephrasing.");
    }
    setBusy(false);
    inputRef.current && inputRef.current.focus();
  }

  async function remove(id) {
    await persist(items.filter((i) => i.id !== id));
  }

  async function saveGoal() {
    const g = Math.max(1, Math.round(Number(goalDraft) || goal));
    setGoal(g);
    setGoalDraft(String(g));
    setEditGoal(false);
    try {
      await window.storage.set(GOAL_KEY, JSON.stringify(g));
    } catch {}
    refreshWeek(g);
  }

  const today = new Date();
  const dateLabel = today.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const sans = { fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif" };

  return (
    <div className="min-h-screen bg-white text-black" style={sans}>
      <div className="max-w-md mx-auto px-5 pb-16">
        {/* Header — nutrition-label style */}
        <header className="pt-8">
          <h1
            className="font-black leading-none"
            style={{ fontSize: "34px", letterSpacing: "-0.02em" }}
          >
            Protein Facts
          </h1>
          <p className="text-sm mt-1" style={{ color: "#6b6b6b" }}>
            {dateLabel}
          </p>
          <div className="mt-3" style={{ height: 8, background: "#111" }} />
        </header>

        {/* Total vs goal */}
        <section className="pt-4">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-xs uppercase tracking-widest" style={{ color: "#6b6b6b" }}>
                today
              </div>
              <div
                className="font-black leading-none"
                style={{ fontSize: "64px", letterSpacing: "-0.03em", color: hit ? "#1b7a43" : "#111" }}
              >
                {total}
                <span className="text-2xl align-baseline font-bold"> g</span>
              </div>
            </div>
            <div className="text-right pb-1">
              {editGoal ? (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={goalDraft}
                    onChange={(e) => setGoalDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveGoal()}
                    className="w-20 border-2 border-black px-2 py-1 text-right font-bold"
                    autoFocus
                  />
                  <button
                    onClick={saveGoal}
                    className="bg-black text-white px-3 py-2 text-sm font-bold"
                  >
                    Set
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setEditGoal(true)}
                  className="text-sm underline underline-offset-4"
                  style={{ color: "#6b6b6b" }}
                >
                  goal {goal} g
                </button>
              )}
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-3" style={{ height: 14, background: "#ececec" }}>
            <div
              style={{
                height: "100%",
                width: pct + "%",
                background: hit ? "#1b7a43" : "#111",
                transition: "width 400ms ease",
              }}
            />
          </div>
          {hit && (
            <p className="mt-2 text-sm font-bold" style={{ color: "#1b7a43" }}>
              Goal reached.
            </p>
          )}
        </section>

        {/* Input */}
        <section className="mt-6">
          <div className="border-2 border-black">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  log();
                }
              }}
              rows={2}
              placeholder="4 fried eggs, 2 spoons of sauerkraut…"
              className="w-full px-3 py-3 outline-none resize-none text-base"
              disabled={busy}
            />
            <button
              onClick={log}
              disabled={busy || !input.trim()}
              className="w-full bg-black text-white font-bold py-3 text-base disabled:opacity-40"
            >
              {busy ? "Estimating…" : "Log it"}
            </button>
          </div>
          {error && (
            <p className="mt-2 text-sm font-bold" style={{ color: "#b3261e" }}>
              {error}
            </p>
          )}
        </section>

        {/* Item list */}
        <section className="mt-6">
          <div style={{ height: 4, background: "#111" }} />
          {!ready ? (
            <p className="py-4 text-sm" style={{ color: "#6b6b6b" }}>
              Loading…
            </p>
          ) : items.length === 0 ? (
            <p className="py-4 text-sm" style={{ color: "#6b6b6b" }}>
              Nothing logged yet. Type what you ate.
            </p>
          ) : (
            <ul>
              {items.map((it) => (
                <li
                  key={it.id}
                  className="flex items-baseline justify-between py-3"
                  style={{ borderBottom: "1px solid #dcdcdc" }}
                >
                  <div className="pr-3 min-w-0">
                    <span className="font-bold">{it.name}</span>
                    {it.amount && (
                      <span className="ml-2 text-sm" style={{ color: "#6b6b6b" }}>
                        {it.amount}
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-3 shrink-0">
                    <span className="font-black tabular-nums">{it.protein} g</span>
                    <button
                      onClick={() => remove(it.id)}
                      aria-label={"Remove " + it.name}
                      className="text-lg leading-none px-1"
                      style={{ color: "#6b6b6b" }}
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 7-day history */}
        <section className="mt-8">
          <div style={{ height: 8, background: "#111" }} />
          <div className="flex justify-between items-end pt-3">
            <span className="text-xs uppercase tracking-widest" style={{ color: "#6b6b6b" }}>
              last 7 days
            </span>
          </div>
          <div className="flex items-end justify-between gap-2 mt-3" style={{ height: 72 }}>
            {week.map((d, i) => {
              const h = d.goal > 0 ? Math.min(1, d.total / d.goal) : 0;
              const isToday = i === week.length - 1;
              return (
                <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full">
                  <div
                    className="w-full"
                    title={d.total + " g"}
                    style={{
                      height: Math.max(3, h * 56),
                      background:
                        d.total >= d.goal ? "#1b7a43" : isToday ? "#111" : "#bdbdbd",
                    }}
                  />
                  <span
                    className="mt-1 text-xs"
                    style={{ color: isToday ? "#111" : "#6b6b6b", fontWeight: isToday ? 700 : 400 }}
                  >
                    {d.label}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs" style={{ color: "#6b6b6b" }}>
            Estimates are approximate. Values in grams.
          </p>
        </section>
      </div>
    </div>
  );
}
