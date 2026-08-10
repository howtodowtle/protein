// Regression tests for the offline queue and the day log in index.html.
// Zero dependencies: `node test/queue.test.js`. Runs the real inline script
// under a minimal DOM shim rather than re-implementing it.
const fs = require("fs");
const vm = require("vm");

// The focused element, shared the way document.activeElement is in a browser.
let activeElement = null;

function makeEl(id) {
  const el = {
    id, textContent: "", value: "", placeholder: "", title: "",
    disabled: false, type: "", href: "",
    style: new Proxy({}, { get: (t, k) => t[k] || "", set: (t, k, v) => (t[k] = v, true) }),
    children: [],
    className: "",
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    listeners: {},
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    // The preconnect tag is removed and re-added to re-open an idle connection,
    // so a shim that never detached anything would let it pile up.
    remove() {
      const i = this.parent ? this.parent.children.indexOf(this) : -1;
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    },
    setAttribute() {}, select() {},
    selectionStart: null,
    setSelectionRange(start) { this.selectionStart = start; },
    focus() { activeElement = this; },
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); },
    click() { (this.listeners.click || []).forEach((f) => f()); },
    // Clearing innerHTML must really empty the node: the app rebuilds its lists
    // that way, and a shim that kept stale children would hide render bugs.
    get innerHTML() { return this._html || ""; },
    set innerHTML(v) {
      this._html = v;
      if (v) return;
      // Detaching the focused element blurs it and drops its selection.
      if (activeElement && this.contains(activeElement)) {
        activeElement.selectionStart = null;
        activeElement = null;
      }
      this.children.length = 0;
    },
  };
  return el;
}

function makeHarness({ fetchImpl, online = true, store = {}, streamCapable = true }) {
  const els = {};
  activeElement = null;
  const document = {
    getElementById: (id) => (els[id] ||= makeEl(id)),
    createElement: (tag) => makeEl("<" + tag + ">"),
    head: makeEl("head"),
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    listeners: {},
    hidden: false,
    get activeElement() { return activeElement; },
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const windowListeners = {};
  const sandbox = {
    document, localStorage,
    window: {
      addEventListener(t, f) { (windowListeners[t] ||= []).push(f); },
      _listeners: windowListeners,
    },
    navigator: { onLine: online },
    location: { protocol: "http:" },
    crypto: { randomUUID: () => "id-" + (sandbox.__n = (sandbox.__n || 0) + 1) },
    fetch: fetchImpl,
    console,
    // The retry timer is a real one, and a pending 15s hold would otherwise keep
    // the test process alive that much longer after the last check has run.
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout,
    JSON, Math, Date, Object, Array, String, Number, Error, Promise, URL,
    // The stream machinery, borrowed from the host. A real browser has all
    // three or is one the app treats as stream-incapable; streamCapable: false
    // is that browser.
    ...(streamCapable ? { TextDecoder, ReadableStream, AbortController } : {}),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const src = fs.readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8")
    .match(/<script>([\s\S]*)<\/script>/)[1];
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx);
  return { ctx, store, els, windowListeners, document };
}

const ok = (r) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ content: [{ type: "text", text: JSON.stringify(r) }] }),
});
const httpErr = (status, msg) => ({
  ok: false, status,
  text: async () => JSON.stringify({ error: { message: msg } }),
});
const netFail = () => { throw new TypeError("Failed to fetch"); };

// SSE machinery. A streamed response's body hands out frames one microtask at
// a time, the way a provider drips them. A frame can also be a behavior — a
// function returning a promise — so a stream can park on a gate mid-answer,
// or die the way an aborted read does.
const enc = new TextEncoder();
// Given the request's signal, the reader also dies the way a real one does
// when the app calls the request off — without it, a stream the app has
// abandoned would keep feeding a test that is no longer listening.
const sse = (frames, signal) => {
  const gone = () => { const e = new Error("aborted"); e.name = "AbortError"; return e; };
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ i: 0, async read() {
      await Promise.resolve();
      if (signal && signal.aborted) throw gone();
      if (this.i >= frames.length) return { done: true };
      const f = frames[this.i++];
      if (typeof f === "function") {
        await f();
        if (signal && signal.aborted) throw gone();
        return this.read();
      }
      return { done: false, value: enc.encode(f) };
    } }) },
    // Streaming reads the body as a stream; reaching for text() means the app
    // took the wrong path.
    text: async () => { throw new Error("text() on a streamed response"); },
  };
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// A read or request that never delivers: pending until the app cuts it off,
// then failing the way an aborted fetch does.
const abortsWith = (signal) => new Promise((_, reject) => {
  signal.addEventListener("abort", () => {
    const e = new Error("aborted"); e.name = "AbortError"; reject(e);
  });
});
// Something the test holds shut and opens when it is ready to: `held` is what
// the app waits on, `release` is the test letting it through.
const gate = () => {
  let release;
  const held = new Promise((r) => (release = r));
  return { held, release };
};
// The SSE line a chunk arrives on, and one builder per wire format the app
// claims to speak — each holding nothing but its own shape.
const frame = (chunk) => "data: " + JSON.stringify(chunk) + "\n\n";
const aDelta = (text) => frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const gDelta = (text) => frame({ candidates: [{ content: { parts: [{ text }] } }] });
const oDelta = (content) => frame({ choices: [{ delta: { content } }] });
// A reasoning model thinks out loud in chunks that carry no answer text at all.
const oReason = (reasoning_content) => frame({ choices: [{ delta: { reasoning_content, content: null } }] });
// The chunk that ends an openai-compatible stream carries no text, only the
// reason it is the last one.
const oFinish = (reason) => frame({ choices: [{ delta: {}, finish_reason: reason }] });
// A whole answer, in the two shapes the app can be handed one: as a body it
// asked to be streamed and was not, and as a plain non-streamed response.
const oWhole = ({ content = "", reasoning, finish }) => JSON.stringify({
  choices: [{ message: { role: "assistant", content, reasoning_content: reasoning }, finish_reason: finish }],
});
const aWhole = (text, extra) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ content: [{ type: "text", text }], ...extra }),
});
// One part of each pending entry, top to bottom, asked for by class rather than
// position — a photo entry grows a thumbnail ahead of the column holding these.
const pendPart = (h, cls) => h.els["pending"].children.map((li) =>
  (descendants(li).find((c) => c.className === cls) || {}).textContent);
// The status line under each pending entry.
const pendMeta = (h) => pendPart(h, "pend-meta");
// The first item of the only day, for the tests that log exactly one thing.
// Empty rather than absent when nothing was written, so a test that expected
// an item reports the miss instead of throwing and taking the rest with it.
const only = (h) => (Object.values(days(h))[0] || [])[0] || {};

// Long enough for the app's own promises to run out. A test waiting on one of
// its timers passes the wait it needs.
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// Read through the app's own key constants: a rename in index.html must break
// these loudly, not silently make them read an absent key and pass.
const q = (h) => JSON.parse(h.store[h.ctx.KEY_QUEUE] || "[]");
const days = (h) => JSON.parse(h.store[h.ctx.KEY_DAYS] || "{}");
// The rendered list, top to bottom: the names, and the class each row carries.
const shown = (h) => h.els["items"].children.map((li) => li.children[0].children[0].textContent);
const marks = (h) => h.els["items"].children.map((li) => li.className);
// Everything inside the open editor, flattened. Which line a field was laid out
// on, and which group it was nested into, is layout: a test asking for "the
// button that says Save" should not have to know, and should not break the day
// the rows are dealt out differently.
const descendants = (n) => n.children.flatMap((c) => [c].concat(descendants(c)));
const editParts = (h) => {
  const li = h.els["items"].children.find((l) => /editing/.test(l.className));
  return li ? descendants(li) : [];
};
// Fields are asked for by class, buttons by what they say — each by the thing
// about it that a person editing a row would actually go looking for.
const fld = (h, cls) => editParts(h).find((c) => c.className.includes(cls));
const ctl = (h, label) => editParts(h).find((c) => c.textContent === label);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}

const baseStore = () => ({ "protein.apiKey": "sk-test", "protein.provider": "anthropic" });
// The same for the other two providers the tests reach for, since a key lives
// under a per-provider name once the provider is not the default.
const dsStore = () => ({ "protein.provider": "deepseek", "protein.apiKey.deepseek": "sk-ds" });
const geminiStore = () => ({ "protein.provider": "gemini", "protein.apiKey.gemini": "AIza-test" });

(async () => {
  // ---- 1. happy path: enqueue -> drain -> lands in days, queue empty
  {
    console.log("1. happy path");
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => ok([{ name: "Eggs", amount: "4", protein_g: 25 }]) });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    check("queued immediately", q(h).length === 1, q(h));
    await settle();
    check("queue drained", q(h).length === 0, q(h));
    const d = days(h);
    const k = Object.keys(d)[0];
    check("item written to today", d[k] && d[k][0].protein === 25, d);
  }

  // ---- 2. offline: entry survives, no attempt burned, then drains on reconnect
  {
    console.log("2. offline capture -> reconnect");
    let mode = "down";
    const h = makeHarness({
      online: false, store: baseStore(),
      fetchImpl: async () => { if (mode === "down") netFail(); return ok([{ name: "Quark", amount: "200 g", protein_g: 19 }]); },
    });
    h.els["food-input"].value = "200g quark";
    h.els["log-btn"].click();
    await settle();
    check("still queued", q(h).length === 1, q(h));
    check("no attempt burned", q(h)[0].attempts === 0, q(h)[0]);
    check("not parked", q(h)[0].parked === false, q(h)[0]);
    check("error recorded", /network error/.test(q(h)[0].error), q(h)[0].error);

    mode = "up";
    h.ctx.navigator.onLine = true;
    h.windowListeners.online.forEach((f) => f());
    await settle();
    check("drained after online event", q(h).length === 0, q(h));
    check("protein landed", Object.values(days(h))[0][0].protein === 19, days(h));
  }

  // ---- 3. terminal 401: parked on first failure, no retry storm
  {
    console.log("3. HTTP 401 parks immediately");
    let calls = 0;
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => { calls++; return httpErr(401, "invalid x-api-key"); } });
    h.els["food-input"].value = "toast";
    h.els["log-btn"].click();
    await settle();
    check("one call only", calls === 1, calls);
    check("parked", q(h)[0].parked === true, q(h)[0]);
    check("attempts = 1", q(h)[0].attempts === 1, q(h)[0]);
    check("provider message verbatim", /invalid x-api-key/.test(q(h)[0].error), q(h)[0].error);
    check("HTTP status in message", /HTTP 401/.test(q(h)[0].error), q(h)[0].error);
  }

  // ---- 4. 429: retryable, one attempt per trigger, parks at MAX_ATTEMPTS
  {
    console.log("4. HTTP 429 backs off across triggers, parks at 3");
    let calls = 0;
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => { calls++; return httpErr(429, "rate limit"); } });
    h.els["food-input"].value = "yoghurt";
    h.els["log-btn"].click();
    await settle();
    check("1 call after submit", calls === 1, calls);
    check("attempts 1, unparked", q(h)[0].attempts === 1 && !q(h)[0].parked, q(h)[0]);

    h.document.listeners.visibilitychange.forEach((f) => f());
    await settle();
    check("2 calls after reopen", calls === 2, calls);
    check("attempts 2, unparked", q(h)[0].attempts === 2 && !q(h)[0].parked, q(h)[0]);

    h.document.listeners.visibilitychange.forEach((f) => f());
    await settle();
    check("3 calls", calls === 3, calls);
    check("parked at MAX_ATTEMPTS", q(h)[0].parked === true, q(h)[0]);

    h.document.listeners.visibilitychange.forEach((f) => f());
    await settle();
    check("parked entry not retried", calls === 3, calls);
  }

  // ---- 5. ordering: three entries drain oldest-first, in one pass
  {
    console.log("5. sequential ordering");
    const order = [];
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => {
        const sent = JSON.parse(init.body).messages[0].content;
        order.push(sent.slice(sent.lastIndexOf("\"") - 1));
        return ok([{ name: "X", amount: "", protein_g: 1 }]);
      },
    });
    ["a", "b", "c"].forEach((t) => { h.els["food-input"].value = t; h.els["log-btn"].click(); });
    check("all three queued", q(h).length === 3, q(h).length);
    await settle();
    check("queue empty", q(h).length === 0, q(h));
    check("drained in submit order", order.join("") === 'a"b"c"', order);
    check("three items in day", Object.values(days(h))[0].length === 3, days(h));
  }

  // ---- 6. date stamped at enqueue, not at drain
  {
    console.log("6. date stamped at enqueue");
    const h = makeHarness({ online: false, store: baseStore(), fetchImpl: async () => netFail() });
    h.els["food-input"].value = "late night snack";
    h.els["log-btn"].click();
    await settle();
    const stamped = q(h)[0].date;
    check("date present on entry", /^\d{4}-\d{2}-\d{2}$/.test(stamped), stamped);
    // Rewrite the stamp to yesterday, then let it succeed: it must land on yesterday.
    const st = q(h);
    st[0].date = "2020-01-01";
    h.store[h.ctx.KEY_QUEUE] = JSON.stringify(st);
    h.ctx.navigator.onLine = true;
    h.ctx.fetch = async () => ok([{ name: "Snack", amount: "1", protein_g: 5 }]);
    h.windowListeners.online.forEach((f) => f());
    await settle();
    check("landed on the stamped day, not today", !!days(h)["2020-01-01"], days(h));
    check("today untouched", Object.keys(days(h)).length === 1, days(h));
  }

  // ---- 7. no API key: entry held, nothing sent, drains after key is saved
  {
    console.log("7. no API key");
    let calls = 0;
    const h = makeHarness({ store: { "protein.provider": "anthropic" }, fetchImpl: async () => { calls++; return ok([{ name: "Y", amount: "", protein_g: 3 }]); } });
    h.els["food-input"].value = "steak";
    h.els["log-btn"].click();
    await settle();
    check("nothing sent", calls === 0, calls);
    check("entry held", q(h).length === 1 && !q(h)[0].parked, q(h));

    h.els["provider-select"].value = "anthropic";
    h.els["api-key-input"].value = "sk-later";
    h.els["api-key-save"].click();
    await settle();
    check("drained after key saved", q(h).length === 0, q(h));
    check("one call", calls === 1, calls);
  }

  // ---- 8. empty parse result parks with a clear message
  {
    console.log("8. model returns []");
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => ok([]) });
    h.els["food-input"].value = "asdfgh";
    h.els["log-btn"].click();
    await settle();
    check("parked", q(h)[0].parked === true, q(h)[0]);
    check("no phantom day entry", Object.keys(days(h)).length === 0, days(h));
  }

  // ---- 9. retry unparks and succeeds
  {
    console.log("9. manual retry");
    let good = false;
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => (good ? ok([{ name: "Z", amount: "", protein_g: 7 }]) : httpErr(400, "bad request")) });
    h.els["food-input"].value = "cheese";
    h.els["log-btn"].click();
    await settle();
    check("parked after 400", q(h)[0].parked === true, q(h)[0]);
    good = true;
    h.ctx.retryPending(q(h)[0].id);
    await settle();
    check("succeeded on retry", q(h).length === 0, q(h));
    check("attempts reset then cleared", Object.values(days(h))[0][0].protein === 7, days(h));
  }

  // ---- 10. discard while in flight does not resurrect the entry
  {
    console.log("10. discard mid-flight");
    const g = gate();
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => { await g.held; return ok([{ name: "W", amount: "", protein_g: 9 }]); } });
    h.els["food-input"].value = "in flight";
    h.els["log-btn"].click();
    const id = q(h)[0].id;
    h.ctx.dropPending(id);
    check("removed from queue", q(h).length === 0, q(h));
    g.release();
    await settle();
    check("still empty", q(h).length === 0, q(h));
    check("no day entry written", Object.keys(days(h)).length === 0, days(h));
  }

  // ---- 11. correcting a logged item edits it in place
  {
    console.log("11. edit a logged item");
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => ok([{ name: "Eggs", amount: "4", protein_g: 25 }]) });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    const before = Object.values(days(h))[0][0];

    // Stand-in for a field a later version adds: a correction must merge over
    // the stored item, not rebuild it from the fields the editor happens to
    // know, or fixing one number silently deletes another.
    const seeded = days(h), day = Object.keys(seeded)[0];
    seeded[day][0].note = "keep me";
    h.store[h.ctx.KEY_DAYS] = JSON.stringify(seeded);

    h.ctx.startEdit(before.id);
    const name = fld(h, "edit-name"), amount = fld(h, "edit-amount"), grams = fld(h, "edit-grams");
    check("fields prefilled from the item", name.value === "Eggs" && grams.value === 25, [name.value, grams.value]);

    name.value = "  Fried eggs  ";
    amount.value = "4 large";
    grams.value = "31.6";
    ctl(h, "Save").click();

    const after = Object.values(days(h))[0][0];
    check("name trimmed and saved", after.name === "Fried eggs", after);
    check("amount saved", after.amount === "4 large", after);
    check("protein rounded to an integer", after.protein === 32, after);
    check("id preserved", after.id === before.id, [before.id, after.id]);
    check("an unknown field survives the edit", after.note === "keep me", after);
    check("still one item", Object.values(days(h))[0].length === 1, days(h));
    check("edit mode closed", h.ctx.editingId === null, h.ctx.editingId);
  }

  // ---- 12. an empty name is refused, and cancel discards the draft
  {
    console.log("12. edit guards");
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => ok([{ name: "Quark", amount: "200 g", protein_g: 19 }]) });
    h.els["food-input"].value = "200g quark";
    h.els["log-btn"].click();
    await settle();
    const id = Object.values(days(h))[0][0].id;

    h.ctx.startEdit(id);
    fld(h, "edit-name").value = "   ";
    ctl(h, "Save").click();
    check("blank name not saved", Object.values(days(h))[0][0].name === "Quark", days(h));
    check("still editing", h.ctx.editingId === id, h.ctx.editingId);

    // cancel: the typed draft is thrown away, the stored item is untouched
    fld(h, "edit-name").value = "Skyr";
    ctl(h, "cancel").click();
    check("cancel discards the draft", Object.values(days(h))[0][0].name === "Quark", days(h));
    check("edit mode closed", h.ctx.editingId === null, h.ctx.editingId);
  }

  // ---- 13. a background render mid-edit keeps the draft and the caret
  {
    console.log("13. render while editing");
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => ok([{ name: "Eggs", amount: "4", protein_g: 25 }]) });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();

    h.ctx.startEdit(Object.values(days(h))[0][0].id);
    const li = h.els["items"].children[0];
    const name = fld(h, "edit-name");
    check("name field focused on open", h.document.activeElement === name, h.document.activeElement);
    name.value = "half-typed";
    name.selectionStart = 4;

    h.ctx.render(); // stands in for a queue drain or an online event
    const after = h.els["items"].children[0];
    check("same node re-attached", after === li, after && after.className);
    check("draft text kept", fld(h, "edit-name").value === "half-typed", fld(h, "edit-name").value);
    check("focus restored", h.document.activeElement === name, h.document.activeElement && h.document.activeElement.className);
    check("caret restored", name.selectionStart === 4, name.selectionStart);
  }

  // ---- 14. list order: newest first by default, by grams on request
  {
    console.log("14. sorting");
    // The queue drains in submission order (see 5), so reply N answers entry N.
    const replies = [
      [{ name: "Egg", amount: "", protein_g: 20 }],
      [{ name: "Rice", amount: "", protein_g: 5 }],
      [{ name: "Milk", amount: "", protein_g: 9 }],
    ];
    let call = 0;
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => ok(replies[call++]) });
    ["egg", "rice", "milk"].forEach((t) => { h.els["food-input"].value = t; h.els["log-btn"].click(); });
    await settle();

    check("stored oldest first", days(h)[Object.keys(days(h))[0]].map((i) => i.name).join() === "Egg,Rice,Milk", days(h));
    check("shown newest first", shown(h).join() === "Milk,Rice,Egg", shown(h));
    check("toggle labelled by mode", h.els["sort-toggle"].textContent === "newest first", h.els["sort-toggle"].textContent);

    h.els["sort-toggle"].click();
    check("sorted by grams, highest first", shown(h).join() === "Egg,Milk,Rice", shown(h));
    check("toggle relabelled", h.els["sort-toggle"].textContent === "most protein", h.els["sort-toggle"].textContent);
    check("choice persisted", h.store[h.ctx.KEY_SORT] === "protein", h.store[h.ctx.KEY_SORT]);

    // A stored value nobody recognises reads as the default, so the grams order
    // above must give way to newest-first.
    h.store[h.ctx.KEY_SORT] = "sideways";
    h.ctx.render();
    check("unknown mode falls back to newest first", shown(h).join() === "Milk,Rice,Egg", shown(h));

    h.els["sort-toggle"].click();
    check("toggling out of an unknown mode lands on a known one", shown(h).join() === "Egg,Milk,Rice", shown(h));
    h.els["sort-toggle"].click();
    check("third mode is certainty", h.els["sort-toggle"].textContent === "least sure", h.els["sort-toggle"].textContent);
    h.els["sort-toggle"].click();
    check("cycles back round to the default", h.els["sort-toggle"].textContent === "newest first", h.els["sort-toggle"].textContent);
    check("and back to newest first order", shown(h).join() === "Milk,Rice,Egg", shown(h));
  }

  // ---- 15. certainty: marked, sorted, and cleared by a correction
  {
    console.log("15. certainty");
    const stored = (h) => days(h)[Object.keys(days(h))[0]];

    const h = makeHarness({
      store: { ...baseStore(), "protein.sort": "certainty" },
      fetchImpl: async () => ok([
        { name: "Quark", amount: "200 g", protein_g: 19, certainty: "high" },
        { name: "Camembert", amount: "3 slices", protein_g: 12, certainty: "low" },
        { name: "Bread", amount: "2 slices", protein_g: 8, certainty: "medium" },
        // A word from a later schema, or a model that ignored the enum.
        { name: "Mystery", amount: "1", protein_g: 3, certainty: "probably" },
      ]),
    });
    h.els["food-input"].value = "everything";
    h.els["log-btn"].click();
    await settle();

    // One lookup, read for whichever field the assertion is about.
    const item = (name) => stored(h).find((i) => i.name === name);

    // One assertion over the whole fixture, so adding a case to it cannot leave
    // a hand-picked index quietly checking the wrong row.
    check("known words kept verbatim, unknown collapses to no claim",
      stored(h).map((i) => i.certainty).join() === "high,low,medium,", stored(h));
    // Least sure first, and the one that made no claim last of all — below even
    // the sure ones, since it is not a thing the user was asked to check.
    check("least sure first, no claim last", shown(h).join() === "Camembert,Bread,Quark,Mystery", shown(h));
    check("every row drawn, unrated included", marks(h).join() === "cert-low,cert-medium,cert-high,cert-unrated", marks(h));
    check("hint explains the dotting", /Dotted/.test(h.els["items-hint"].textContent), h.els["items-hint"].textContent);

    // Saving is not a claim about the number: the editor carries the row's own
    // certainty across untouched, and the button is the only thing that sets it.
    h.ctx.startEdit(item("Camembert").id);
    check("editor opens on the stored certainty", fld(h, "cert-btn").textContent === "not sure", fld(h, "cert-btn").textContent);
    fld(h, "edit-grams").value = "14";
    ctl(h, "Save").click();
    check("grams corrected", item("Camembert").protein === 14, stored(h));
    check("certainty untouched by the edit", item("Camembert").certainty === "low", stored(h));

    // Tapping cycles it, and it wraps: one tap on the least sure is "sure".
    h.ctx.startEdit(item("Camembert").id);
    fld(h, "cert-btn").click();
    check("tapping cycles the label", fld(h, "cert-btn").textContent === "sure", fld(h, "cert-btn").textContent);
    ctl(h, "Save").click();
    check("certainty saved from the button", item("Camembert").certainty === "high", stored(h));
    check("and it sorts as sure", shown(h).join() === "Bread,Camembert,Quark,Mystery", shown(h));

    // An item the model made no claim about opens as sure: someone looked.
    h.ctx.startEdit(item("Mystery").id);
    check("an unrated row opens as sure", fld(h, "cert-btn").textContent === "sure", fld(h, "cert-btn").textContent);
    ctl(h, "Save").click();
    check("saving gives it a claim", item("Mystery").certainty === "high", stored(h));

    // Once the last of them is settled, the hint goes back to the plain one.
    h.ctx.startEdit(item("Bread").id);
    fld(h, "cert-btn").click();
    fld(h, "cert-btn").click();
    check("cycling wraps round the whole list", fld(h, "cert-btn").textContent === "sure", fld(h, "cert-btn").textContent);
    ctl(h, "Save").click();
    check("nothing dotted left", marks(h).join() === "cert-high,cert-high,cert-high,cert-high", marks(h));
    check("hint back to the plain instruction", /Tap an item/.test(h.els["items-hint"].textContent), h.els["items-hint"].textContent);

    // Items logged before the field existed read as unrated, not as guesses.
    const h2 = makeHarness({
      store: { ...baseStore(), "protein.days": JSON.stringify({ [Object.keys(days(h))[0]]: [{ id: "old", name: "Legacy", amount: "", protein: 5 }] }) },
      fetchImpl: async () => ok([]),
    });
    check("an item with no certainty field reads as unrated", marks(h2).join() === "cert-unrated", marks(h2));
  }

  // ---- 16. read-only history: full list, one day, and the ways in and out
  {
    console.log("16. history view");
    // Dates relative to now so the "Today"/"Yesterday" wording is exercised.
    const fmtD = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmtD(d); };
    const seeded = {
      [ago(0)]: [{ id: "a", name: "Eggs", amount: "4", protein: 25 }],
      [ago(1)]: [{ id: "b", name: "Quark", amount: "200 g", protein: 19 }, { id: "c", name: "Bread", amount: "2 slices", protein: 8 }],
      [ago(10)]: [{ id: "d", name: "Steak", amount: "200 g", protein: 52 }],
      [ago(3)]: [],  // a key left empty by a deleted item — not a day you logged
    };
    const h = makeHarness({
      store: { ...baseStore(), "protein.goal": "40", "protein.days": JSON.stringify(seeded) },
      fetchImpl: async () => ok([]),
    });
    const body = () => h.els["history-body"];
    const kids = (cls) => body().children.find((c) => c.className === cls);
    const isOpen = () => h.els["history"].classList.contains("open");
    const isDay = () => h.els["history"].classList.contains("day-view");

    check("closed on load", !isOpen());

    // The link opens the full list: newest first, empty day dropped.
    h.els["history-link"].click();
    check("open after link", isOpen());
    check("list mode, not day", isOpen() && !isDay());
    const list = kids("hist-list");
    check("only days with items shown", list.children.length === 3, list.children.length);
    const whens = list.children.map((r) => r.children[0].children[0].textContent);
    check("newest first, worded", whens[0] === "Today" && whens[1] === "Yesterday", whens);
    check("sub counts the days", h.els["history-sub"].textContent === "3 days logged", h.els["history-sub"].textContent);

    // A day whose total cleared the goal marks its figure.
    const steakRow = list.children[2];
    check("goal-hit day flagged in the list", /hist-day-total hit/.test(steakRow.children[1].className), steakRow.children[1].className);

    // Tapping a row opens that day, read-only, newest first, with no controls.
    list.children[1].click(); // Yesterday: Quark then Bread
    check("day-view after tap", isDay());
    check("title is the day", h.els["history-title"].textContent === "Yesterday", h.els["history-title"].textContent);
    const dayItems = kids("hist-items");
    check("items newest first", dayItems.children.map((li) => li.children[0].children[0].textContent).join() === "Bread,Quark", dayItems.children.map((li) => li.children[0].children[0].textContent));
    check("grams shown", dayItems.children.map((li) => li.children[1].textContent).join() === "8 g,19 g", dayItems.children.map((li) => li.children[1].textContent));
    check("sub reads total vs goal", h.els["history-sub"].textContent === "27 g · goal 40 g", h.els["history-sub"].textContent);

    // Back returns to the list; close leaves.
    h.els["history-back"].click();
    check("back to the list", isOpen() && !isDay() && !!kids("hist-list"));
    h.els["history-close"].click();
    check("close leaves", !isOpen());

    // A week bar is the other way in: the columns run oldest→today, so the last
    // is today, and tapping it opens today read-only. A dashed goal line rides
    // over the columns as a non-column child, so filter to the seven day columns.
    const cols = h.els["week"].children.filter((c) => c.className.includes("day-col"));
    check("seven columns", cols.length === 7, cols.length);
    check("goal line drawn", h.els["week"].children.some((c) => c.className === "goal-line"));
    cols[6].click();
    check("bar opens history", isOpen() && isDay());
    check("today's items shown", h.els["history-title"].textContent === "Today" && kids("hist-items").children[0].children[0].children[0].textContent === "Eggs", h.els["history-title"].textContent);

    // Escape closes from anywhere.
    h.document.listeners.keydown.forEach((f) => f({ key: "Escape" }));
    check("escape closes", !isOpen());

    // A day that hit the goal reads it back in the detail sub-line.
    h.store["protein.goal"] = "20";
    h.ctx.openHistory(ago(0)); // today: Eggs = 25 >= 20
    check("goal-reached wording", h.els["history-sub"].textContent === "25 g · goal reached", h.els["history-sub"].textContent);
    check("sub marked hit", h.els["history-sub"].classList.contains("hit"), h.els["history-sub"].className);
  }

  // ---- 17. empty history states clearly
  {
    console.log("17. empty history");
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => ok([]) });
    h.els["history-link"].click();
    check("empty-list message", h.els["history-body"].children[0].textContent === "Nothing logged yet.", h.els["history-body"].children[0].textContent);
    // A bar for a day with nothing on it still opens, and says so.
    h.ctx.openHistory("2020-01-01");
    check("empty-day message", h.els["history-body"].children[0].textContent === "Nothing logged this day.", h.els["history-body"].children[0].textContent);
  }

  // The figure column of each rendered row (right side, first child), top to bottom
  // — the same shape as shown/marks, so a row's number is read the way its name is.
  const figures = (h) => h.els["items"].children.map((li) => li.children[1].children[0].textContent);

  // ---- 18. calories parse into their own fields, alongside protein
  {
    console.log("18. calories stored");
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async () => ok([{ name: "Eggs", amount: "4", protein_g: 25, certainty: "high", calories_kcal: 360, calorie_certainty: "high" }]),
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    const it = Object.values(days(h))[0][0];
    check("protein stored", it.protein === 25, it);
    check("calories stored", it.calories === 360, it);
    check("calorie certainty stored", it.calorieCertainty === "high", it);
  }

  // ---- 19. an item without calorie fields defaults cleanly (old data, or a
  //          model that answered only protein)
  {
    console.log("19. calories default when absent");
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => ok([{ name: "Toast", amount: "1", protein_g: 4 }]) });
    h.els["food-input"].value = "toast";
    h.els["log-btn"].click();
    await settle();
    const it = Object.values(days(h))[0][0];
    check("calories default to 0", it.calories === 0, it);
    check("calorie certainty empty", it.calorieCertainty === "", it);
  }

  // ---- 20. the calorie view swaps totals, units, certainty, sort and the goal
  {
    console.log("20. calorie view");
    const h = makeHarness({
      store: { ...baseStore(), "protein.sort": "protein" },
      fetchImpl: async () => ok([
        // Oil: a sure 0 g protein but a low-certainty calorie guess — the two
        // certainties genuinely differ on the same item.
        { name: "Oil", amount: "1 tbsp", protein_g: 0, certainty: "high", calories_kcal: 120, calorie_certainty: "low" },
        { name: "Chicken", amount: "150 g", protein_g: 46, certainty: "high", calories_kcal: 250, calorie_certainty: "high" },
      ]),
    });
    h.els["food-input"].value = "oil and chicken";
    h.els["log-btn"].click();
    await settle();

    // Protein view (default): grams, "most protein", both rows sure, goal line drawn.
    check("protein figure shown in grams", figures(h)[0] === "46 g", figures(h));
    check("sort labelled most protein", h.els["sort-toggle"].textContent === "most protein", h.els["sort-toggle"].textContent);
    check("protein certainties", marks(h).join() === "cert-high,cert-high", marks(h));
    check("goal line present", h.els["week"].children.some((c) => c.className === "goal-line"));
    check("goal block shown", h.els["goal-area"].style.display !== "none", h.els["goal-area"].style.display);

    // Switch to calories.
    h.els["metric-calories"].click();
    check("calorie figure shown in kcal", figures(h)[0] === "250 kcal", figures(h));
    check("total carries the kcal unit", /kcal/.test(h.els["total"].innerHTML), h.els["total"].innerHTML);
    check("sort relabelled most calories", h.els["sort-toggle"].textContent === "most calories", h.els["sort-toggle"].textContent);
    check("calorie certainties differ from protein", marks(h).join() === "cert-high,cert-low", marks(h));
    check("no goal line in calorie view", !h.els["week"].children.some((c) => c.className === "goal-line"));
    check("goal block hidden", h.els["goal-area"].style.display === "none", h.els["goal-area"].style.display);
    check("choice persisted", h.store["protein.metric"] === "calories", h.store["protein.metric"]);

    // And back: protein certainties return.
    h.els["metric-protein"].click();
    check("back to protein certainties", marks(h).join() === "cert-high,cert-high", marks(h));
  }

  // ---- 21. editing on one screen leaves the other figure untouched
  {
    console.log("21. per-metric edit isolation");
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async () => ok([{ name: "Eggs", amount: "4", protein_g: 25, certainty: "high", calories_kcal: 360, calorie_certainty: "high" }]),
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    const id = Object.values(days(h))[0][0].id;

    // Edit calories: the editor is filled from the calorie figure, protein is left alone.
    h.els["metric-calories"].click();
    h.ctx.startEdit(id);
    check("editor shows the calorie figure", fld(h, "edit-grams").value === 360, fld(h, "edit-grams").value);
    fld(h, "edit-grams").value = "400";
    ctl(h, "Save").click();
    const a = Object.values(days(h))[0][0];
    check("calories updated", a.calories === 400, a);
    check("protein untouched by a calorie edit", a.protein === 25, a);
    check("calorie certainty preserved", a.calorieCertainty === "high", a);

    // Edit protein: calories survive.
    h.els["metric-protein"].click();
    h.ctx.startEdit(id);
    check("editor shows the protein figure", fld(h, "edit-grams").value === 25, fld(h, "edit-grams").value);
    fld(h, "edit-grams").value = "30";
    ctl(h, "Save").click();
    const b = Object.values(days(h))[0][0];
    check("protein updated", b.protein === 30, b);
    check("calories survive a protein edit", b.calories === 400, b);
  }

  // ---- 22. the calorie view mirrors into history, without a goal
  {
    console.log("22. calorie history");
    const h = makeHarness({
      store: { ...baseStore(), "protein.goal": "40", "protein.metric": "calories" },
      fetchImpl: async () => ok([]),
    });
    // Seed through the app's own key for today, then re-render — the same date the
    // app would write, with no second copy of the date format to drift.
    const today = h.ctx.todayKey();
    h.store[h.ctx.KEY_DAYS] = JSON.stringify({
      [today]: [
        { id: "a", name: "Eggs", amount: "4", protein: 25, calories: 360, calorieCertainty: "high" },
        { id: "b", name: "Oil", amount: "1 tbsp", protein: 0, calories: 120, calorieCertainty: "low" },
      ],
    });
    h.ctx.render();
    // Today's total on the main screen: calories summed, in kcal.
    check("total sums calories", h.els["total"].innerHTML.replace(/<[^>]+>/g, "").trim() === "480 kcal", h.els["total"].innerHTML);

    h.ctx.openHistory(today);
    check("history sub states kcal, no goal", h.els["history-sub"].textContent === "480 kcal", h.els["history-sub"].textContent);
    const items = h.els["history-body"].children.find((c) => c.className === "hist-items");
    check("history item figures in kcal", items.children.map((li) => li.children[1].textContent).join() === "120 kcal,360 kcal", items.children.map((li) => li.children[1].textContent));
  }

  // ---- 23. a struggling entry no longer holds up the one behind it
  {
    console.log("23. head-of-line");
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => {
        const sent = JSON.parse(init.body).messages[0].content;
        return /stuck/.test(sent)
          ? httpErr(429, "rate limit")
          : ok([{ name: "Toast", amount: "1 slice", protein_g: 4 }]);
      },
    });
    h.ctx.MAX_INFLIGHT = 1;  // strictly one at a time: the shape the bug lived in
    h.els["food-input"].value = "stuck";
    h.els["log-btn"].click();
    await settle();
    h.els["food-input"].value = "toast";
    h.els["log-btn"].click();
    await settle();
    check("entry behind it landed anyway", Object.values(days(h))[0][0].protein === 4, days(h));
    check("the failing one is still queued", q(h).length === 1 && /rate limit/.test(q(h)[0].error), q(h));
  }

  // ---- 24. a retryable failure retries itself, with nothing from the user
  {
    console.log("24. automatic retry");
    let calls = 0, good = false;
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async () => { calls++; return good ? ok([{ name: "Quark", amount: "200 g", protein_g: 19 }]) : httpErr(503, "overloaded"); },
    });
    // Long enough to still be waiting at the first check, short enough not to
    // slow the suite. How long it really waits is the app's business.
    h.ctx.RETRY_MS[0] = 60;
    h.els["food-input"].value = "200g quark";
    h.els["log-btn"].click();
    await settle();
    check("first attempt failed", calls === 1 && q(h)[0].attempts === 1, [calls, q(h)[0]]);

    good = true;
    // No click, no reopen, no reconnect — only the app's own timer.
    await settle(150);
    check("retried on its own", calls === 2, calls);
    check("landed without a trigger", Object.values(days(h))[0][0].protein === 19, days(h));
  }

  // ---- 25. a fresh entry does not wait for one already in flight, and the day
  //          still reads in the order things were logged
  {
    console.log("25. fresh entry overtakes an in-flight one");
    const g = gate();
    let started = 0;
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => {
        started++;
        const slow = /slow/.test(JSON.parse(init.body).messages[0].content);
        if (slow) await g.held;
        return ok([{ name: slow ? "Slow" : "Fast", amount: "", protein_g: 1 }]);
      },
    });
    h.els["food-input"].value = "slow";
    h.els["log-btn"].click();
    await settle();
    h.els["food-input"].value = "fast";
    h.els["log-btn"].click();
    await settle();
    check("both are in flight at once", started === 2, started);
    check("the fresh one has already landed", Object.values(days(h))[0].length === 1, days(h));

    g.release();
    await settle();
    check("both landed", q(h).length === 0 && Object.values(days(h))[0].length === 2, days(h));
    // Answers came back last-first; the day is filed first-first regardless.
    check("day reads in log order", Object.values(days(h))[0].map((i) => i.name).join() === "Slow,Fast", days(h));
    check("list shows newest first", shown(h).join() === "Fast,Slow", shown(h));
  }

  // ---- 26. a request that times out is the entry's problem, not the network's
  {
    console.log("26. request timeout");
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: (url, init) => abortsWith(init.signal),
    });
    h.ctx.REQUEST_MS = 50;
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle(120);
    check("attempt burned", q(h)[0].attempts === 1, q(h)[0]);
    check("not treated as offline", !/network error/.test(q(h)[0].error), q(h)[0].error);
    check("message states the wait", /No answer from .* after 0s/.test(q(h)[0].error), q(h)[0].error);
  }

  // ---- 27. a streamed answer previews each item as it completes, and commits
  //          exactly what a whole answer would have
  {
    console.log("27. streaming with live progress");
    let sentBody = null;
    const g = gate();
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => {
        sentBody = JSON.parse(init.body);
        return sse([
          aDelta('[{"name":"Fried eggs","amount":"4 eggs, ~220 g","protein_g":25,"certainty":"high",'),
          aDelta('"calories_kcal":360,"calorie_certainty":"high"},'),
          () => g.held,
          aDelta('{"name":"Bauernbrot","amount":"3 slices, ~135 g","protein_g":10,"certainty":"medium","calories_kcal":340,"calorie_certainty":"medium"}]'),
        ]);
      },
    });
    h.els["food-input"].value = "4 fried eggs and 3 slices of bauernbrot";
    h.els["log-btn"].click();
    await settle();
    check("streaming was asked for", sentBody.stream === true, sentBody);
    check("still queued while streaming", q(h).length === 1, q(h));
    check("finished item previewed", /estimating…\nFried eggs 25 g/.test(pendMeta(h)[0]), pendMeta(h));
    check("unfinished item is not", !/Bauernbrot/.test(pendMeta(h)[0]), pendMeta(h));
    // The preview follows the metric switch like every other number on screen.
    h.els["metric-calories"].click();
    check("preview follows the metric", /Fried eggs 360 kcal/.test(pendMeta(h)[0]), pendMeta(h));
    h.els["metric-protein"].click();

    g.release();
    await settle();
    check("committed on completion", q(h).length === 0, q(h));
    const d = Object.values(days(h))[0];
    check("both items landed", d.length === 2 && d[0].protein === 25 && d[1].protein === 10, d);
    check("fields as a whole answer gives", d[1].certainty === "medium" && d[1].calories === 340, d[1]);
    check("no progress left behind", Object.keys(h.ctx.streamProgress).length === 0, h.ctx.streamProgress);
  }

  // ---- 28. a stream that goes quiet is cut off soft: attempt burned, retried
  //          on the app's own timer
  {
    console.log("28. mid-stream stall");
    let calls = 0;
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => {
        calls++;
        if (calls > 1) return ok([{ name: "Eggs", amount: "4", protein_g: 25 }]);
        // One byte arrives, then silence until the app cuts the read off.
        return sse([aDelta("["), () => abortsWith(init.signal)]);
      },
    });
    h.ctx.STALL_MS = 40;
    h.ctx.RETRY_MS[0] = 120;
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle(100);
    check("cut off after the stall, not the full wait", calls === 1 && q(h)[0].attempts === 1, [calls, q(h)]);
    check("message says it stalled", /stalled/.test(q(h)[0].error), q(h)[0].error);
    check("soft, not offline", q(h)[0].parked === false && !/network error/.test(q(h)[0].error), q(h)[0]);
    await settle(150);
    check("retried on its own and landed", calls === 2 && q(h).length === 0, [calls, q(h)]);
    check("item written", Object.values(days(h))[0][0].protein === 25, days(h));
  }

  // ---- 29. a browser that cannot read streams never asks for one
  {
    console.log("29. stream-incapable browser");
    let sentBody = null;
    const h = makeHarness({
      streamCapable: false,
      store: baseStore(),
      fetchImpl: async (url, init) => { sentBody = JSON.parse(init.body); return ok([{ name: "Eggs", amount: "4", protein_g: 25 }]); },
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    check("no stream asked for", !("stream" in sentBody), sentBody);
    check("landed through the text path", Object.values(days(h))[0][0].protein === 25, days(h));
    // The converse — stream asked for, body unreadable — is what every ok()
    // response above exercises: tests 1-26 all run with streamCapable on.
  }

  // ---- 30. gemini streams through its own endpoint and chunk shape
  {
    console.log("30. gemini streaming");
    let sentUrl = "";
    const h = makeHarness({
      store: geminiStore(),
      fetchImpl: async (url) => {
        sentUrl = url;
        return sse([
          gDelta('[{"name":"Joghurt","amount":"250 g","protein_g":11,"certainty":"high","calories_kcal":150,"calorie_certainty":"medium"},'),
          gDelta('{"name":"Magerquark","amount":"200 g","protein_g":19,"certainty":"high","calories_kcal":135,"calorie_certainty":"high"}]'),
        ]);
      },
    });
    h.els["food-input"].value = "joghurt und magerquark";
    h.els["log-btn"].click();
    await settle();
    check("streaming endpoint used", /:streamGenerateContent\?alt=sse$/.test(sentUrl), sentUrl);
    check("both items landed", Object.values(days(h))[0].length === 2, days(h));
  }

  // ---- 31. openai-compatible chunks: null reasoning deltas and [DONE] pass through
  {
    console.log("31. deepseek streaming");
    const h = makeHarness({
      store: dsStore(),
      fetchImpl: async () => sse([
        oDelta(null), // a reasoning chunk: content is null, not text
        oDelta('[{"name":"Toast","amount":"1 slice","protein_g":4,"certainty":"high","calories_kcal":90,"calorie_certainty":"medium"}]'),
        "data: [DONE]\n\n",
      ]),
    });
    h.els["food-input"].value = "toast";
    h.els["log-btn"].click();
    await settle();
    check("landed", Object.values(days(h))[0][0].protein === 4, days(h));
    check("queue drained", q(h).length === 0, q(h));
  }

  // ---- 32. discarding an entry mid-stream leaves nothing behind
  {
    console.log("32. discard mid-stream");
    const g = gate();
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async () => sse([
        aDelta('[{"name":"W","amount":"","protein_g":9,"certainty":"high","calories_kcal":50,"calorie_certainty":"high"},'),
        () => g.held,
        aDelta('{"name":"X","amount":"","protein_g":3,"certainty":"high","calories_kcal":20,"calorie_certainty":"high"}]'),
      ]),
    });
    h.els["food-input"].value = "in flight";
    h.els["log-btn"].click();
    await settle();
    h.ctx.dropPending(q(h)[0].id);
    check("removed from queue", q(h).length === 0, q(h));
    g.release();
    await settle();
    check("no day entry written", Object.keys(days(h)).length === 0, days(h));
    check("no progress left behind", Object.keys(h.ctx.streamProgress).length === 0, h.ctx.streamProgress);
  }

  // ---- 33. a stream can talk without ever answering — pings restart the stall
  //          clock forever, so the whole-request clock is what has to end it
  {
    console.log("33. endless keep-alive stream");
    const ping = frame({ type: "ping" });
    const frames = [];
    for (let i = 0; i < 60; i++) frames.push(() => delay(5), ping);
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => sse(frames, init.signal),
    });
    h.ctx.REQUEST_MS = 60;
    h.ctx.STALL_MS = 500;  // never the one that fires: a ping keeps restarting it
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle(200);
    check("cut off by the whole-request clock", q(h).length === 1 && q(h)[0].attempts === 1, q(h));
    check("named as the wait that ran out", /No answer/.test(q(h)[0].error), q(h)[0].error);
    check("stall not blamed for it", !/stalled/.test(q(h)[0].error), q(h)[0].error);
    // The leak this guards: a send that never settles holds its slot forever,
    // and three of them stop the queue.
    check("the in-flight slot came back", Object.keys(h.ctx.sending).length === 0, h.ctx.sending);
  }

  // ---- 34. a provider that ignored the stream flag answered anyway; the
  //          bytes are paid for either way
  {
    console.log("34. plain answer to a streamed request");
    const plain = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify([{ name: "Eggs", amount: "4", protein_g: 25, certainty: "high", calories_kcal: 360, calorie_certainty: "high" }]) }],
    });
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => sse([plain]) });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    check("read as the plain body it is", only(h).protein === 25, days(h));
    check("queue drained", q(h).length === 0, q(h));
  }

  // ---- 35. the last frame need not be newline-terminated to count
  {
    console.log("35. unterminated final frame");
    const one = aDelta('[{"name":"Eggs","amount":"4","protein_g":25,"certainty":"high","calories_kcal":360,"calorie_certainty":"high"}]');
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async () => sse([one.replace(/\n+$/, "")]),
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    check("last frame still read", only(h).protein === 25, days(h));
  }

  // ---- 36. "data: null" parses to a chunk that is not one
  {
    console.log("36. null chunk");
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async () => sse([
        "data: null\n\n",
        aDelta('[{"name":"Eggs","amount":"4","protein_g":25,"certainty":"high","calories_kcal":360,"calorie_certainty":"high"}]'),
      ]),
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    check("survived it and read the answer", only(h).protein === 25, days(h));
    check("no failure recorded", q(h).length === 0, q(h));
  }

  // ---- 37. a refusal can arrive after the 200 that opened the stream
  {
    console.log("37. mid-stream provider error");
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async () => sse([
        aDelta('[{"name":"Eg'),
        frame({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      ]),
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    check("provider's words shown", /Overloaded/.test(q(h)[0].error), q(h)[0].error);
    check("not the half-written array", !/Model did not return JSON/.test(q(h)[0].error), q(h)[0].error);
    check("retryable", q(h)[0].parked === false && q(h)[0].attempts === 1, q(h)[0]);
  }

  // ---- 38. an answer that stopped for room, read the ordinary way. There is
  //          text before the cut, so the model was writing the array and outgrew
  //          it — nothing a second ask can shorten, and turning thinking off
  //          would only hand the same answer a smaller ceiling.
  {
    console.log("38. truncated whole body, no stream");
    let calls = 0;
    const h = makeHarness({
      streamCapable: false, store: baseStore(),
      fetchImpl: async () => { calls++; return aWhole('[{"name":"Eg', { stop_reason: "max_tokens" }); },
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    // Nothing is scheduled: an answer that outgrew the room is terminal, so
    // there is no timer here to wait out.
    await settle();
    check("named as the ceiling it was", /ran out of room/.test(q(h)[0].error), q(h)[0].error);
    check("not blamed on the model's writing", !/Model did not return JSON/.test(q(h)[0].error), q(h)[0].error);
    check("nothing written from half an answer", Object.keys(days(h)).length === 0, days(h));
    check("told what to do about it", /fewer foods/.test(q(h)[0].error), q(h)[0].error);
    // Not one wasted ask: the three a soft failure would have bought, and not
    // even the one a downgrade buys — there is nothing here left to turn off.
    check("asked once and no more", calls === 1, calls);
    check("parked", q(h)[0].parked === true, q(h)[0]);
  }

  // ---- 39. the same news, carried by the chunk that ends a stream
  {
    console.log("39. truncated stream");
    const h = makeHarness({
      store: { ...dsStore(), "protein.thinking.deepseek": "off" },
      fetchImpl: async () => sse([oDelta('[{"name":"Eg'), oFinish("length"), "data: [DONE]\n\n"]),
    });
    h.els["food-input"].value = "a long list";
    h.els["log-btn"].click();
    // Nothing is scheduled on this path: thinking is already off, so there is
    // no downgrade left and the failure parks where it stands.
    await settle();
    check("named as the ceiling it was", /ran out of room/.test(q(h)[0].error), q(h)[0].error);
    check("told what to do about it", /fewer foods/.test(q(h)[0].error), q(h)[0].error);
    check("parked rather than asked again", q(h)[0].parked === true, q(h)[0]);
    check("no progress left behind", Object.keys(h.ctx.streamProgress).length === 0, h.ctx.streamProgress);
  }

  // ---- 40. the same news again, but from a stream that said nothing else. A
  //          reasoning model streams its thinking as content-less chunks, so a
  //          budget spent entirely on thinking arrives as an answer of no text
  //          at all — which sends it down the branch meant for a provider that
  //          ignored the stream flag, where the body is SSE frames and will not
  //          parse. What the frames already said about why it stopped has to
  //          survive that. 41 has the retry this earns; here it only has to be
  //          read as a ceiling rather than as a model with nothing to say.
  {
    console.log("40. a stream of nothing but thinking");
    const h = makeHarness({
      store: { ...dsStore(), "protein.thinking.deepseek": "on" },
      fetchImpl: async () => sse([
        oReason("Need estimate each. "), oReason("Wait rule says ~10g. "),
        oFinish("length"), "data: [DONE]\n\n",
      ]),
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    check("read as the ceiling, not as a model with nothing to say",
      /spent its whole token budget thinking/.test(q(h)[0].error), q(h)[0].error);
    check("marked for the try without thinking", q(h)[0].noThink === true, q(h)[0]);
  }

  // ---- 41. the reported bug, whole: thinking on, the budget spent entirely on
  //          thinking, and the answer never started. The body comes back as one
  //          plain object to a streamed request, which is the route that hid it.
  //          Both halves are one run — what the user is told, and what the app
  //          does about it — because the second only means anything given the
  //          first: the row promises a try without thinking, so the request that
  //          follows had better be one.
  {
    console.log("41. all of the budget spent thinking");
    const trace = "We need answer as JSON array. Wait rule says a bit is ~10g. ".repeat(60);
    const bodies = [];
    const h = makeHarness({
      store: { ...dsStore(), "protein.thinking.deepseek": "on", "protein.effort.deepseek": "max" },
      fetchImpl: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return sse([bodies.length === 1
          ? oWhole({ reasoning: trace, finish: "length" })
          : oDelta('[{"name":"Kefir","amount":"500 g","protein_g":35,"certainty":"high","calories_kcal":300,"calorie_certainty":"medium"}]')]);
      },
    });
    h.ctx.RETRY_MS[0] = 60;   // long enough to still be waiting at the first checks
    h.els["food-input"].value = "500 g kefir, 2 bananas";
    h.els["log-btn"].click();
    await settle();
    const err = q(h)[0].error;
    check("said where the budget went", /spent its whole token budget thinking/.test(err), err);
    check("not one word of the trace", !/Wait rule says/.test(err), err);
    check("short enough for a queue row", err.length < 300, err.length);
    check("the row promises the retry it will make", /Will retry without thinking/.test(pendMeta(h)[0]), pendMeta(h)[0]);
    check("not parked while that try is left", q(h)[0].parked === false, q(h)[0]);
    check("first try was allowed to think",
      bodies[0].thinking.type === "enabled" && bodies[0].reasoning_effort === "max", bodies[0]);

    await settle(120);
    check("asked again without thinking", bodies.length === 2, bodies.length);
    check("and told the provider so", bodies[1].thinking.type === "disabled", bodies[1]);
    check("with the effort dropped too", bodies[1].reasoning_effort === undefined, bodies[1]);
    check("keeping every token the thinking had been using",
      bodies[1].max_tokens === bodies[0].max_tokens, bodies.map((b) => b.max_tokens));
    check("the second answer landed", only(h).protein === 35, days(h));
    check("queue drained", q(h).length === 0, q(h));
  }

  // ---- 42. a second ceiling means the answer is the long thing, not the
  //          thinking — and there is nothing left to turn off
  {
    console.log("42. truncated again without thinking");
    let calls = 0;
    const h = makeHarness({
      store: { ...dsStore(), "protein.thinking.deepseek": "on" },
      fetchImpl: async () => { calls++; return sse([oWhole({ finish: "length" })]); },
    });
    h.ctx.RETRY_MS[0] = 20;
    h.els["food-input"].value = "everything I ate today";
    h.els["log-btn"].click();
    await settle(80);
    check("tried twice and no more", calls === 2, calls);
    check("parked", q(h)[0].parked === true, q(h)[0]);
    check("told what to do about it", /fewer foods/.test(q(h)[0].error), q(h)[0].error);
  }

  // ---- 43. a downgrade earns a try the retry list did not budget for, so the
  //          step it waits on is the last one rather than one off the end. A
  //          step off the end is `undefined`, and now + undefined is NaN, which
  //          mark() reads as no cooldown at all and deletes — so the entry does
  //          not hang, it goes straight back out with no wait. The try happens
  //          either way; whether it waited is the whole difference.
  {
    console.log("43. a downgrade past the end of the retry list");
    let calls = 0;
    const h = makeHarness({
      store: { ...dsStore(), "protein.thinking.deepseek": "on" },
      fetchImpl: async () => {
        calls++;
        // Two soft failures first, so the truncation lands on attempt 3 — one
        // past the last step the list holds. The wait it earns is widened only
        // once those are through, so the state below can be read at leisure
        // instead of inside a window timed to the millisecond.
        if (calls <= 2) return httpErr(503, "overloaded");
        h.ctx.RETRY_MS[1] = 5000;
        return sse([oWhole({ finish: "length" })]);
      },
    });
    h.ctx.RETRY_MS[0] = 5;
    h.ctx.RETRY_MS[1] = 5;
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    const id = q(h)[0].id;
    check("the truncation landed past the last step", q(h)[0].attempts === 3, q(h)[0]);
    check("and bought a try the list had no step for", q(h)[0].noThink === true, q(h)[0]);
    // Waiting, and on a moment that arrives — not sent, and not on the NaN that
    // an unclamped step would have left, which mark() drops entirely.
    check("which waits its turn rather than going out at once",
      h.ctx.cooling[id] > Date.now() && !h.ctx.sending[id], h.ctx.cooling);
    // Rather than sit out the wait: a trigger beats a cooldown, which is what
    // drainNow is for.
    h.ctx.drainNow();
    await settle();
    check("and then goes, and parks", calls === 4 && q(h)[0].parked === true, q(h)[0]);
  }

  // ---- 44. a model that thought and then said nothing, having stopped of its
  //          own accord: a whim, not a ceiling, and worth one more ask
  {
    console.log("44. reasoning and no answer");
    let calls = 0;
    const h = makeHarness({
      store: dsStore(),
      fetchImpl: async () => {
        calls++;
        return sse([calls === 1
          ? oWhole({ reasoning: "Thinking about eggs.", finish: "stop" })
          : oDelta('[{"name":"Eggs","amount":"4","protein_g":25,"certainty":"high","calories_kcal":360,"calorie_certainty":"high"}]')]);
      },
    });
    h.ctx.RETRY_MS[0] = 60;   // long enough to still be waiting at the first check
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    check("named for what it was", /returned its reasoning and no answer/.test(q(h)[0].error), q(h)[0].error);
    check("not blamed on a ceiling", !/room|budget/.test(q(h)[0].error), q(h)[0].error);
    check("still worth asking again", q(h)[0].parked === false && q(h)[0].attempts === 1, q(h)[0]);
    await settle(120);
    check("and the retry landed", only(h).protein === 25, days(h));
  }

  // ---- 45. thinking can overrun a clock as easily as a token budget, and the
  //          remedy is the same one. A stall is not this: that is a dead
  //          connection, which says nothing about what was asked.
  {
    console.log("45. thinking that outlasts the clock");
    const bodies = [];
    const h = makeHarness({
      store: { ...dsStore(), "protein.thinking.deepseek": "on" },
      fetchImpl: (url, init) => {
        bodies.push(JSON.parse(init.body));
        // The first try never answers and is cut off by the whole-request clock;
        // the try that follows is the one that has to arrive.
        if (bodies.length === 1) return abortsWith(init.signal);
        return sse([oDelta('[{"name":"Eggs","amount":"4","protein_g":25,"certainty":"high","calories_kcal":360,"calorie_certainty":"high"}]')]);
      },
    });
    h.ctx.REQUEST_MS = 20;
    h.ctx.RETRY_MS[0] = 60;   // long enough to still be waiting at the first checks
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    check("named as the wait that ran out",
      q(h).length === 1 && /No answer from/.test(q(h)[0].error), q(h));
    check("marked for the try without thinking", q(h)[0].noThink === true, q(h)[0]);
    await settle(120);
    check("which went out without it",
      bodies.length === 2 && bodies[1].thinking.type === "disabled", bodies[1]);
    // Dropping the thinking must not drop the room to answer in with. The first
    // try lost to a clock, not to a ceiling, so a retry that quietly asked for an
    // eighth of the tokens could truncate where the original would not have — and
    // a truncation with text before it is terminal, so it would park the entry
    // and blame the length of the meal for what was the provider being slow.
    check("with no less room than the try that timed out",
      bodies[1].max_tokens === bodies[0].max_tokens, bodies.map((b) => b.max_tokens));
    check("and landed", only(h).protein === 25, days(h));
  }

  // ---- 46. a stall is a dead connection, not thinking that ran long, so the
  //          same request is still the one worth making
  {
    console.log("46. a stall is not an overrun");
    const h = makeHarness({
      store: { ...dsStore(), "protein.thinking.deepseek": "on" },
      fetchImpl: async (url, init) => sse([oReason("thinking… "), () => abortsWith(init.signal)]),
    });
    h.ctx.STALL_MS = 20;
    h.ctx.RETRY_MS[0] = 40;
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    check("named as the stall it was", /stalled/.test(q(h)[0].error), q(h)[0].error);
    check("and not blamed on the thinking", q(h)[0].noThink === undefined, q(h)[0]);
    // Sat out rather than abandoned mid-flight: the retry this scheduled would
    // otherwise land during a later scenario, and the harnesses share the focused
    // element between them.
    await settle(120);
    check("the retry stalls the same way and is still not blamed on it",
      q(h)[0].attempts === 2 && q(h)[0].noThink === undefined, q(h)[0]);
  }

  // ---- 47. a model that simply wrote prose still says so in one line
  {
    console.log("47. long garbage is cut to a line");
    const h = makeHarness({
      streamCapable: false, store: baseStore(),
      fetchImpl: async () => aWhole("Here is the JSON array you asked for.\n".repeat(150)),
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    const err = q(h)[0].error;
    check("still named for what it is", /Model did not return JSON/.test(err), err);
    check("cut to a queue row", err.length < 300, err.length);
    check("and marked as cut", /…$/.test(err), err);
    check("no newlines of its own", !/\n/.test(err), err);
  }

  // ---- 48. the budget the request actually carries, which is the whole bug:
  //          a model left on its provider's default reasons anyway, so the
  //          default gets the room too
  {
    console.log("48. the budget on the wire");
    // What one request put on the wire, for a store and the wire format that
    // store speaks. The answer is empty because nothing here reads it.
    const sentFor = async (store, delta = oDelta) => {
      let body = null;
      const h = makeHarness({
        store, fetchImpl: async (url, init) => {
          body = JSON.parse(init.body);
          return sse([delta("[]")]);
        },
      });
      h.els["food-input"].value = "4 eggs";
      h.els["log-btn"].click();
      await settle();
      return body;
    };
    const on = await sentFor({ ...dsStore(), "protein.thinking.deepseek": "on" });
    const byDefault = await sentFor(dsStore());
    const off = await sentFor({ ...dsStore(), "protein.thinking.deepseek": "off" });
    const gemStore = { "protein.provider": "gemini", "protein.apiKey.gemini": "AIza" };
    const gem = await sentFor(gemStore, gDelta);
    // An effort set alongside an explicit "off" used to win, which turned the
    // thinking back on and then gave it an answer-sized ceiling to do it in —
    // the exact shape of the bug this file is mostly about.
    const gemOffWithEffort = await sentFor(
      { ...gemStore, "protein.thinking.gemini": "off", "protein.effort.gemini": "high" }, gDelta);
    check("thinking on gets room to think", on.max_tokens === 16000, on.max_tokens);
    // The budget and the model it is asked of have to move together: the older
    // deepseek-chat caps max_tokens at 8k, so a default that drifted back to it
    // would 400 on every request the moment thinking was anything but off.
    check("and asks it of a model that can take it", on.model === "deepseek-v4-flash", on.model);
    check("so does the provider default", byDefault.max_tokens === 16000, byDefault.max_tokens);
    // And so does thinking off, which is the point: the setting says whether to
    // think, not how much room the answer gets. A smaller ceiling here is what
    // made turning thinking off cost an entry its answer.
    check("and so does thinking off", off.max_tokens === 16000, off.max_tokens);
    check("and gemini says the same in its own words",
      gem.generationConfig.maxOutputTokens === 16000, gem.generationConfig);
    check("an effort cannot turn thinking back on",
      gemOffWithEffort.generationConfig.thinkingConfig.thinkingBudget === 0,
      gemOffWithEffort.generationConfig);
  }

  // ---- 49. a photo rides the entry: queued, on the wire, gone once logged
  {
    console.log("49. photo + text");
    const img = { mediaType: "image/jpeg", data: "AAAA" };
    let sentBody = null;
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => { sentBody = JSON.parse(init.body); return ok([{ name: "Eggs", amount: "4", protein_g: 25 }]); },
    });
    h.ctx.setPhoto(img);
    check("preview row shown", h.els["photo-row"].classList.contains("has-photo"), h.els["photo-row"].className);
    h.els["food-input"].value = "with ketchup";
    h.els["log-btn"].click();
    check("image queued with the entry", q(h).length === 1 && q(h)[0].image.data === "AAAA", q(h));
    check("box cleared, photo included", h.ctx.pendingPhoto === null && !h.els["photo-row"].classList.contains("has-photo"), h.ctx.pendingPhoto);
    await settle();
    const content = sentBody.messages[0].content;
    check("image block first, words after", Array.isArray(content) && content[0].source.media_type === "image/jpeg" && content[0].source.data === "AAAA", content);
    check("photo prompt with the text as caption", content[1].text === h.ctx.PHOTO_TEXT_PROMPT + JSON.stringify("with ketchup"), content[1]);
    check("item landed without the photo", only(h).protein === 25 && !("image" in only(h)), only(h));
    check("queue drained", q(h).length === 0, q(h));
  }

  // ---- 50. photo alone is an entry: its own prompt, its own face in the list
  {
    console.log("50. photo only");
    const img = { mediaType: "image/jpeg", data: "BBBB" };
    const g = gate();
    let sentBody = null;
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => {
        sentBody = JSON.parse(init.body);
        return sse([
          () => g.held,
          aDelta('[{"name":"Pasta","amount":"~250 g","protein_g":9,"certainty":"medium","calories_kcal":400,"calorie_certainty":"medium"}]'),
        ], init.signal);
      },
    });
    h.ctx.setPhoto(img);
    h.els["log-btn"].click();
    await settle();
    check("logged with nothing typed", q(h).length === 1, q(h));
    const thumb = descendants(h.els["pending"].children[0]).find((c) => c.className === "pend-thumb");
    check("thumbnail drawn from the entry", !!thumb && thumb.src === "data:image/jpeg;base64,BBBB", thumb && thumb.src);
    check("wordless entry still reads as itself", pendPart(h, "pend-text")[0] === "Photo", pendPart(h, "pend-text"));
    check("estimating like any other", /estimating…/.test(pendMeta(h)[0]), pendMeta(h));
    check("photo-only prompt, nothing appended", sentBody.messages[0].content[1].text === h.ctx.PHOTO_PROMPT, sentBody.messages[0].content[1]);
    g.release();
    await settle();
    check("committed", only(h).protein === 9, days(h));
    check("queue drained", q(h).length === 0, q(h));
  }

  // ---- 51. text alone is the request it always was — the photo left no trace
  {
    console.log("51. text-only unchanged");
    let sentBody = null;
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => { sentBody = JSON.parse(init.body); return ok([{ name: "Eggs", amount: "4", protein_g: 25 }]); },
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    check("no image field stored", !("image" in q(h)[0]), q(h)[0]);
    await settle();
    const content = sentBody.messages[0].content;
    check("content is the bare string it always was", content === h.ctx.PARSE_PROMPT + JSON.stringify("4 eggs"), typeof content);
    check("no photo wording anywhere in it", !/photo/i.test(content));
  }

  // ---- 52. each provider dresses the same photo in its own wire format
  {
    console.log("52. provider photo shapes");
    const img = { mediaType: "image/jpeg", data: "CCCC" };
    const gItem = gDelta('[{"name":"Reis","amount":"~200 g","protein_g":5,"certainty":"medium","calories_kcal":260,"calorie_certainty":"medium"}]');
    let gBody = null;
    const g1 = makeHarness({
      store: geminiStore(),
      fetchImpl: async (url, init) => { gBody = JSON.parse(init.body); return sse([gItem]); },
    });
    g1.ctx.setPhoto(img);
    g1.els["log-btn"].click();
    await settle();
    const parts = gBody.contents[0].parts;
    check("gemini: inline_data first, text after",
      parts.length === 2 && parts[0].inline_data.mime_type === "image/jpeg" &&
      parts[0].inline_data.data === "CCCC" && parts[1].text === g1.ctx.PHOTO_PROMPT, parts);

    // The same harness again with nothing attached: the one part it always sent.
    g1.els["food-input"].value = "reis";
    g1.els["log-btn"].click();
    await settle();
    check("gemini: text alone keeps its one part",
      gBody.contents[0].parts.length === 1 && "text" in gBody.contents[0].parts[0], gBody.contents[0].parts);

    let dBody = null;
    const d = makeHarness({
      store: dsStore(),
      fetchImpl: async (url, init) => {
        dBody = JSON.parse(init.body);
        return sse([oDelta('[{"name":"Toast","amount":"1 slice","protein_g":4,"certainty":"high","calories_kcal":90,"calorie_certainty":"medium"}]'), "data: [DONE]\n\n"]);
      },
    });
    d.ctx.setPhoto(img);
    d.els["log-btn"].click();
    await settle();
    const dc = dBody.messages[0].content;
    check("openai-compatible: a data URL", dc[0].image_url.url === "data:image/jpeg;base64,CCCC" && dc[1].type === "text", dc);
  }

  // ---- 53. shrinking a photo takes long enough for the box to move on, and
  //          what it moved on to wins: a photo that lands late must not undo
  //          the × that dismissed it, nor ride along on the next entry.
  {
    console.log("53. a photo that arrives late");
    const img = { mediaType: "image/jpeg", data: "DDDD" };
    // The picker, driven the way a phone drives it, with the shrinking held
    // open so the test can act while it is still going.
    const pick = (h) => {
      let done;
      h.ctx.normalizePhoto = () => new Promise((r) => { done = r; });
      h.els["photo-input"].files = [{}];
      h.els["photo-input"].listeners.change[0]();
      return () => done(img);
    };

    const cleared = makeHarness({ store: baseStore(), fetchImpl: async () => ok([]) });
    const finish = pick(cleared);
    cleared.els["photo-clear"].click();
    finish();
    await settle();
    check("the × holds against a late photo", cleared.ctx.pendingPhoto === null, cleared.ctx.pendingPhoto);

    // The same race against Log it: the entry goes without the photo, and the
    // photo must not then attach itself to whatever is typed next.
    let sentBody = null;
    const logged = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => { sentBody = JSON.parse(init.body); return ok([{ name: "Eggs", amount: "4", protein_g: 25 }]); },
    });
    const finishLogged = pick(logged);
    logged.els["food-input"].value = "4 eggs";
    logged.els["log-btn"].click();
    finishLogged();
    await settle();
    check("the entry went as typed", typeof sentBody.messages[0].content === "string", sentBody.messages[0].content);
    check("and the late photo did not stay behind", logged.ctx.pendingPhoto === null, logged.ctx.pendingPhoto);

    // Two picked in a hurry: the one picked last is the one meant, whichever
    // order the two finish shrinking in — so both orders are asked for. The
    // one that finishes first is the interesting one, since a claim staked by
    // reading the counter rather than advancing it would let it win.
    for (const firstDone of [true, false]) {
      const raced = makeHarness({ store: baseStore(), fetchImpl: async () => ok([]) });
      const holds = [];
      raced.ctx.normalizePhoto = () => new Promise((r) => holds.push(r));
      raced.els["photo-input"].files = [{}];
      raced.els["photo-input"].listeners.change[0]();
      raced.els["photo-input"].listeners.change[0]();
      const done = [
        () => holds[0]({ mediaType: "image/jpeg", data: "FIRST" }),
        () => holds[1]({ mediaType: "image/jpeg", data: "SECOND" }),
      ];
      if (!firstDone) done.reverse();
      done.forEach((f) => f());
      await settle();
      check("the photo picked last is the one held, " + (firstDone ? "in pick order" : "out of order"),
        raced.ctx.pendingPhoto && raced.ctx.pendingPhoto.data === "SECOND", raced.ctx.pendingPhoto);
    }
  }

  // ---- 54. the thumbnail is built once and moved, not decoded again on every
  //          redraw the streaming preview asks for
  {
    console.log("54. one thumbnail per queued photo");
    const g = gate();
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => sse([
        aDelta('[{"name":"Pasta","amount":"~250 g","protein_g":9,"certainty":"medium","calories_kcal":400,"calorie_certainty":"medium"},'),
        () => g.held,
        aDelta('{"name":"Sauce","amount":"~80 g","protein_g":2,"certainty":"low","calories_kcal":90,"calorie_certainty":"low"}]'),
      ], init.signal),
    });
    h.ctx.setPhoto({ mediaType: "image/jpeg", data: "EEEE" });
    h.els["log-btn"].click();
    await settle();
    const thumbOf = () => descendants(h.els["pending"].children[0]).find((c) => c.className === "pend-thumb");
    const first = thumbOf();
    check("drawn while estimating", !!first && first.src === "data:image/jpeg;base64,EEEE", first && first.src);
    h.ctx.renderPending();
    h.ctx.render();
    check("the same node survives a redraw", thumbOf() === first, thumbOf() === first);
    g.release();
    await settle();
    check("and is let go of with the entry", Object.keys(h.ctx.thumbNodes).length === 0, h.ctx.thumbNodes);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
