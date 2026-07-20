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
    appendChild(c) { this.children.push(c); return c; },
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

function makeHarness({ fetchImpl, online = true, store = {} }) {
  const els = {};
  activeElement = null;
  const document = {
    getElementById: (id) => (els[id] ||= makeEl(id)),
    createElement: (tag) => makeEl("<" + tag + ">"),
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
    setTimeout, clearTimeout,
    JSON, Math, Date, Object, Array, String, Number, Error, Promise, URL,
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

const settle = () => new Promise((r) => setTimeout(r, 30));
// Read through the app's own key constants: a rename in index.html must break
// these loudly, not silently make them read an absent key and pass.
const q = (h) => JSON.parse(h.store[h.ctx.KEY_QUEUE] || "[]");
const days = (h) => JSON.parse(h.store[h.ctx.KEY_DAYS] || "{}");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}

const baseStore = () => ({ "protein.apiKey": "sk-test", "protein.provider": "anthropic" });

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
    let release;
    const gate = new Promise((r) => (release = r));
    const h = makeHarness({ store: baseStore(), fetchImpl: async () => { await gate; return ok([{ name: "W", amount: "", protein_g: 9 }]); } });
    h.els["food-input"].value = "in flight";
    h.els["log-btn"].click();
    const id = q(h)[0].id;
    h.ctx.dropPending(id);
    check("removed from queue", q(h).length === 0, q(h));
    release();
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

    h.ctx.startEdit(before.id);
    const li = h.els["items"].children[0];
    const [name, row] = li.children;
    const [amount, grams, save] = row.children;
    check("fields prefilled from the item", name.value === "Eggs" && grams.value === 25, [name.value, grams.value]);

    name.value = "  Fried eggs  ";
    amount.value = "4 large";
    grams.value = "31.6";
    save.click();

    const after = Object.values(days(h))[0][0];
    check("name trimmed and saved", after.name === "Fried eggs", after);
    check("amount saved", after.amount === "4 large", after);
    check("protein rounded to an integer", after.protein === 32, after);
    check("id preserved", after.id === before.id, [before.id, after.id]);
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
    let [name, row] = h.els["items"].children[0].children;
    name.value = "   ";
    row.children[2].click();
    check("blank name not saved", Object.values(days(h))[0][0].name === "Quark", days(h));
    check("still editing", h.ctx.editingId === id, h.ctx.editingId);

    // cancel: the typed draft is thrown away, the stored item is untouched
    [name, row] = h.els["items"].children[0].children;
    name.value = "Skyr";
    row.children[3].click();
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
    const name = li.children[0];
    check("name field focused on open", h.document.activeElement === name, h.document.activeElement);
    name.value = "half-typed";
    name.selectionStart = 4;

    h.ctx.render(); // stands in for a queue drain or an online event
    const after = h.els["items"].children[0];
    check("same node re-attached", after === li, after && after.className);
    check("draft text kept", after.children[0].value === "half-typed", after.children[0].value);
    check("focus restored", h.document.activeElement === name, h.document.activeElement && h.document.activeElement.className);
    check("caret restored", name.selectionStart === 4, name.selectionStart);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
