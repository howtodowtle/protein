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

function makeHarness({ fetchImpl, online = true, store = {} }) {
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
    let release;
    const gate = new Promise((r) => (release = r));
    let started = 0;
    const h = makeHarness({
      store: baseStore(),
      fetchImpl: async (url, init) => {
        started++;
        const slow = /slow/.test(JSON.parse(init.body).messages[0].content);
        if (slow) await gate;
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

    release();
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
      fetchImpl: async () => { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; },
    });
    h.els["food-input"].value = "4 eggs";
    h.els["log-btn"].click();
    await settle();
    check("attempt burned", q(h)[0].attempts === 1, q(h)[0]);
    check("not treated as offline", !/network error/.test(q(h)[0].error), q(h)[0].error);
    check("message states the wait", /after 60s/.test(q(h)[0].error), q(h)[0].error);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
