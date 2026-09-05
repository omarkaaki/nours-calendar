// ===========================================================================
//  app.js — all the UI
// ===========================================================================

import { store, uuid, DEFAULT_SHIFT_TYPES } from "./store.js";
import { CLOUD_ENABLED, SUPABASE_URL, VAPID_PUBLIC_KEY, APP_NAME } from "./config.js";

const BUILD = "2026-09-05";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

// ------------------------------------------------------------------ dates ---
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d, 12, 0, 0); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameYmd = (a, b) => ymd(a) === ymd(b);
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS_LONG = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const DAYS_MIN  = ["S","M","T","W","T","F","S"];
const DAYS_SHORT= ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h < 12 ? "am" : "pm";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${pad(m)}${ampm}` : `${hh}${ampm}`;
}
function hoursBetween(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;         // overnight shift
  return mins / 60;
}
const shiftStart = (s, t) => s?.start_time || t?.start || "";
const shiftEnd   = (s, t) => s?.end_time   || t?.end   || "";
const shiftHours = (s, t) => hoursBetween(shiftStart(s, t), shiftEnd(s, t));
const shortLabel = (name = "") => (name.length <= 5 ? name : name.slice(0, 4));

// ------------------------------------------------------------------ state ---
const state = {
  cursor: new Date(),            // which month is on screen
  selected: ymd(new Date()),
  view: "month",
  patternType: null,
  patternDays: new Set([1, 2, 3, 4, 5]),
  editing: null,                 // event being edited
};

// ------------------------------------------------------------------ sheets --
const stack = [];
function openSheet(node) {
  $("scrim").hidden = false;
  node.hidden = false;
  stack.push(node);
  document.documentElement.style.overflow = "hidden";
}
function closeTop() {
  const node = stack.pop();
  if (node) node.hidden = true;
  if (!stack.length) { $("scrim").hidden = true; document.documentElement.style.overflow = ""; }
}
function closeAllSheets() { while (stack.length) closeTop(); }

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

// =========================================================== month rendering
function monthCells() {
  const ws = Number(store.profile.week_start ?? 1);
  const first = new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1, 12);
  const lead = (first.getDay() - ws + 7) % 7;
  const start = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

function renderWeekdays() {
  const ws = Number(store.profile.week_start ?? 1);
  const row = $("weekdays");
  row.innerHTML = "";
  for (let i = 0; i < 7; i++) row.appendChild(el("div", null, DAYS_MIN[(i + ws) % 7]));
}

function renderMonth() {
  const grid = $("grid");
  grid.innerHTML = "";
  const today = ymd(new Date());
  const month = state.cursor.getMonth();

  for (const d of monthCells()) {
    const key = ymd(d);
    const cell = el("button", "cell");
    cell.type = "button";
    if (d.getMonth() !== month) cell.classList.add("out");
    if (key === today) cell.classList.add("today");
    if (key === state.selected) cell.classList.add("selected");
    cell.setAttribute("aria-label", `${DAYS_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`);

    cell.appendChild(el("div", "dnum", String(d.getDate())));

    const shift = store.getShift(key);
    if (shift?.type_id) {
      const t = store.typeById(shift.type_id);
      const chip = el("div", "chip", shortLabel(t.name));
      chip.style.background = t.color;
      cell.appendChild(chip);
    }

    const evs = store.eventsOn(key);
    const dots = el("div", "dots");
    for (const ev of evs.slice(0, 4)) {
      const dot = el("i", "dot");
      dot.style.background = ev.color || "var(--accent)";
      dots.appendChild(dot);
    }
    cell.appendChild(dots);

    cell.addEventListener("click", () => { state.selected = key; renderMonth(); openDay(key); });
    grid.appendChild(cell);
  }
}

function renderSummary() {
  const box = $("summary");
  box.innerHTML = "";
  const y = state.cursor.getFullYear(), m = state.cursor.getMonth();
  let hours = 0, worked = 0;
  const counts = new Map();

  for (const [date, s] of store.shifts) {
    const d = parseYmd(date);
    if (d.getFullYear() !== y || d.getMonth() !== m || !s.type_id) continue;
    const t = store.typeById(s.type_id);
    counts.set(t.id, (counts.get(t.id) || 0) + 1);
    const h = shiftHours(s, t);
    if (h > 0) { hours += h; worked++; }
  }
  const evCount = store.events.filter((e) => {
    const d = parseYmd(e.date); return d.getFullYear() === y && d.getMonth() === m;
  }).length;

  if (!counts.size && !evCount) {
    box.appendChild(el("div", "empty", "Nothing scheduled this month yet. Tap a day to add a shift."));
    return;
  }

  box.appendChild(el("h3", null, `${MONTHS[m]} summary`));
  const row = el("div", "stat-row");
  const a = el("div", "stat"); a.appendChild(el("b", null, hours ? hours.toFixed(hours % 1 ? 1 : 0) : "0"));
  a.appendChild(el("span", null, `hours across ${worked} shift${worked === 1 ? "" : "s"}`));
  const b = el("div", "stat"); b.appendChild(el("b", null, String(evCount)));
  b.appendChild(el("span", null, evCount === 1 ? "event this month" : "events this month"));
  row.append(a, b);
  box.appendChild(row);

  const legend = el("div", "legend");
  for (const t of store.profile.shift_types) {
    const n = counts.get(t.id);
    if (!n) continue;
    const tag = el("span", "tag");
    const sw = el("i", "swatch"); sw.style.background = t.color;
    tag.append(sw, document.createTextNode(`${t.name} · ${n}`));
    legend.appendChild(tag);
  }
  box.appendChild(legend);
}

// ========================================================== agenda rendering
function renderAgenda() {
  const wrap = $("agenda");
  wrap.innerHTML = "";
  const y = state.cursor.getFullYear(), m = state.cursor.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  const todayKey = ymd(new Date());
  let any = false;

  for (let day = 1; day <= last; day++) {
    const d = new Date(y, m, day, 12);
    const key = ymd(d);
    const shift = store.getShift(key);
    const evs = store.eventsOn(key);
    if (!shift?.type_id && !evs.length && !shift?.notes) continue;
    any = true;

    const group = el("div", "agenda-day");
    const head = el("div", "agenda-head" + (key === todayKey ? " is-today" : ""));
    head.appendChild(el("b", null, `${DAYS_SHORT[d.getDay()]} ${day}`));
    head.appendChild(el("span", null, key === todayKey ? "Today" : MONTHS[m]));
    group.appendChild(head);

    if (shift?.type_id) group.appendChild(shiftRow(key, shift));
    for (const ev of evs) group.appendChild(eventRow(ev));
    if (!shift?.type_id && shift?.notes) group.appendChild(noteRow(key, shift));

    wrap.appendChild(group);
  }
  if (!any) wrap.appendChild(el("div", "empty", `Nothing in ${MONTHS[m]} ${y} yet.`));
}

function shiftRow(key, shift) {
  const t = store.typeById(shift.type_id);
  const row = el("button", "row"); row.type = "button";
  const bar = el("i", "bar"); bar.style.background = t.color;
  const body = el("div", "body");
  body.appendChild(el("b", null, t.name));
  const bits = [];
  if (shift.unit) bits.push(shift.unit);
  if (shift.notes) bits.push(shift.notes);
  const h = shiftHours(shift, t);
  if (h > 0) bits.push(`${h.toFixed(h % 1 ? 1 : 0)}h`);
  if (bits.length) body.appendChild(el("span", null, bits.join(" · ")));
  const when = el("div", "when");
  const s = shiftStart(shift, t), e = shiftEnd(shift, t);
  if (s) { const b2 = el("b", null, fmtTime(s)); when.appendChild(b2); if (e) when.appendChild(document.createTextNode(fmtTime(e))); }
  row.append(bar, body, when);
  row.addEventListener("click", () => openDay(key));
  return row;
}

function noteRow(key, shift) {
  const row = el("button", "row"); row.type = "button";
  const bar = el("i", "bar"); bar.style.background = "var(--line)";
  const body = el("div", "body");
  body.appendChild(el("b", null, "Note"));
  body.appendChild(el("span", null, shift.notes));
  row.append(bar, body);
  row.addEventListener("click", () => openDay(key));
  return row;
}

function eventRow(ev) {
  const row = el("button", "row"); row.type = "button";
  const bar = el("i", "bar"); bar.style.background = ev.color || "var(--accent)";
  const body = el("div", "body");
  body.appendChild(el("b", null, ev.title));
  const bits = [];
  if (ev.location) bits.push(ev.location);
  if (ev.notes) bits.push(ev.notes);
  if (ev.remind_minutes != null) bits.push("🔔 " + remindLabel(ev.remind_minutes));
  if (bits.length) body.appendChild(el("span", null, bits.join(" · ")));
  const when = el("div", "when");
  if (ev.all_day) when.appendChild(el("b", null, "All day"));
  else if (ev.start_time) {
    when.appendChild(el("b", null, fmtTime(ev.start_time)));
    if (ev.end_time) when.appendChild(document.createTextNode(fmtTime(ev.end_time)));
  }
  row.append(bar, body, when);
  row.addEventListener("click", () => openEvent(ev));
  return row;
}

function remindLabel(min) {
  if (min === 0) return "at the time";
  if (min < 60) return `${min} min before`;
  if (min < 1440) return `${min / 60} hr before`;
  return `${min / 1440} day${min / 1440 > 1 ? "s" : ""} before`;
}

// ============================================================ the day sheet
function openDay(key) {
  state.selected = key;
  const d = parseYmd(key);
  $("day-title").firstChild.textContent = `${DAYS_LONG[d.getDay()]} ${d.getDate()}`;
  $("day-sub").textContent = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  renderDayBody();
  openSheet($("day-sheet"));
}

function renderDayBody() {
  const key = state.selected;
  const body = $("day-body");
  body.innerHTML = "";
  const shift = store.getShift(key);
  const active = shift?.type_id || null;

  // --- shift type picker ---
  body.appendChild(el("div", "section-label first", "Shift"));
  const grid = el("div", "type-grid");
  for (const t of store.profile.shift_types) {
    const btn = el("button", "type-btn"); btn.type = "button";
    btn.setAttribute("aria-pressed", String(active === t.id));
    const sw = el("i", "sw"); sw.style.background = t.color;
    btn.appendChild(sw);
    btn.appendChild(document.createTextNode(t.name));
    if (t.start) btn.appendChild(el("small", null, `${fmtTime(t.start)}–${fmtTime(t.end)}`));
    btn.addEventListener("click", () => {
      if (active === t.id) store.clearShift(key);
      else store.setShift(key, { type_id: t.id });
      renderDayBody(); refresh();
    });
    grid.appendChild(btn);
  }
  body.appendChild(grid);

  if (active) {
    const t = store.typeById(active);
    body.appendChild(el("div", "section-label", "Times for this day"));
    const two = el("div", "two");
    // Postgres hands times back as HH:MM:SS; the input wants HH:MM.
    const hhmm = (v) => String(v || "").slice(0, 5);

    const mk = (label, value, onchange) => {
      const l = el("label", null, label);
      const i = document.createElement("input");
      i.type = "time"; i.value = hhmm(value);
      i.addEventListener("change", onchange);
      l.appendChild(i);
      return l;
    };

    // Kept as a live element: editing a time has to move this number in front
    // of her, not wait until the sheet is reopened.
    const hoursLine = el("p", "tiny muted");
    hoursLine.style.margin = "6px 0 0";
    const paintHours = () => {
      const h = shiftHours(store.getShift(key), t);
      hoursLine.textContent = h > 0 ? `${h.toFixed(h % 1 ? 1 : 0)} hours` : "";
    };
    const onTime = (field) => (e) => { store.setShift(key, { [field]: e.target.value }); paintHours(); refresh(); };

    two.appendChild(mk("Starts", shift.start_time || t.start, onTime("start_time")));
    two.appendChild(mk("Ends",   shift.end_time   || t.end,   onTime("end_time")));
    body.appendChild(two);
    paintHours();
    body.appendChild(hoursLine);

    const lu = el("label", null, "Ward / unit");
    const iu = document.createElement("input");
    iu.type = "text"; iu.value = shift.unit || ""; iu.placeholder = "Optional";
    iu.addEventListener("change", (e) => store.setShift(key, { unit: e.target.value }));
    lu.appendChild(iu);
    lu.style.marginTop = "13px";
    body.appendChild(lu);
  }

  // --- notes ---
  body.appendChild(el("div", "section-label", "Notes for this day"));
  const ta = document.createElement("textarea");
  ta.value = shift?.notes || "";
  ta.placeholder = "Handover, who you swapped with, how it went…";
  ta.addEventListener("change", (e) => { store.setShift(key, { notes: e.target.value }); refresh(); });
  body.appendChild(ta);

  // --- events ---
  const evs = store.eventsOn(key);
  body.appendChild(el("div", "section-label", "Events"));
  if (!evs.length) body.appendChild(Object.assign(el("p", "tiny muted", "Nothing scheduled."), { style: "margin:0" }));
  for (const ev of evs) body.appendChild(eventRow(ev));

  if (shift?.type_id || shift?.notes) {
    const clear = el("button", "btn ghost block", "Clear this day");
    clear.style.marginTop = "16px";
    clear.addEventListener("click", () => { store.clearShift(key); renderDayBody(); refresh(); toast("Day cleared"); });
    body.appendChild(clear);
  }
}

// ========================================================= the event editor
const EVENT_COLORS = ["#7c3aed","#a855f7","#ec4899","#2563eb","#0d9488","#16a34a","#ea580c","#dc2626"];

function openEvent(ev) {
  state.editing = ev || null;
  $("event-title").textContent = ev ? "Edit event" : "New event";
  $("ev-title").value = ev?.title || "";
  $("ev-date").value = ev?.date || state.selected;
  $("ev-allday").checked = !!ev?.all_day;
  $("ev-start").value = String(ev?.start_time || "09:00").slice(0, 5);
  $("ev-end").value = String(ev?.end_time || "").slice(0, 5);
  $("ev-remind").value = ev?.remind_minutes == null ? "" : String(ev.remind_minutes);
  $("ev-location").value = ev?.location || "";
  $("ev-notes").value = ev?.notes || "";
  $("ev-delete").hidden = !ev;
  syncAllDay();

  const wrap = $("ev-colors");
  wrap.innerHTML = "";
  const chosen = ev?.color || EVENT_COLORS[0];
  for (const c of EVENT_COLORS) {
    const b = el("button", "type-btn"); b.type = "button";
    b.dataset.color = c;
    b.setAttribute("aria-pressed", String(c === chosen));
    b.style.padding = "14px 6px";
    const sw = el("i", "sw"); sw.style.background = c; sw.style.height = "14px";
    b.appendChild(sw);
    b.addEventListener("click", () => {
      [...wrap.children].forEach((n) => n.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
    });
    wrap.appendChild(b);
  }
  openSheet($("event-sheet"));
  if (!ev) setTimeout(() => $("ev-title").focus(), 320);
}

function syncAllDay() { $("ev-times").hidden = $("ev-allday").checked; }

function saveEventFromForm() {
  const chosen = [...$("ev-colors").children].find((n) => n.getAttribute("aria-pressed") === "true");
  const title = $("ev-title").value.trim();
  if (!title) { $("ev-title").focus(); toast("Give it a title first"); return; }
  store.saveEvent({
    id: state.editing?.id,
    title,
    date: $("ev-date").value || state.selected,
    all_day: $("ev-allday").checked,
    start_time: $("ev-start").value,
    end_time: $("ev-end").value,
    location: $("ev-location").value.trim(),
    notes: $("ev-notes").value.trim(),
    color: chosen?.dataset.color || EVENT_COLORS[0],
    remind_minutes: $("ev-remind").value,
  });
  closeTop();
  refresh();
  if (stack.includes($("day-sheet"))) renderDayBody();
  toast("Saved");
}

// ======================================================== the repeat sheet
function openPattern() {
  state.patternType = store.getShift(state.selected)?.type_id || store.profile.shift_types[0]?.id || null;
  $("pat-from").value = state.selected;
  const to = addDays(parseYmd(state.selected), 27);
  $("pat-to").value = ymd(to);
  renderPatternTypes();
  renderPatternDays();
  onPatternModeChange();
  openSheet($("pattern-sheet"));
}

function renderPatternTypes() {
  const wrap = $("pat-types");
  wrap.innerHTML = "";
  for (const t of store.profile.shift_types) {
    const b = el("button", "type-btn"); b.type = "button";
    b.setAttribute("aria-pressed", String(state.patternType === t.id));
    const sw = el("i", "sw"); sw.style.background = t.color;
    b.append(sw, document.createTextNode(t.name));
    b.addEventListener("click", () => { state.patternType = t.id; renderPatternTypes(); updatePatternPreview(); });
    wrap.appendChild(b);
  }
}

function renderPatternDays() {
  const wrap = $("pat-days");
  wrap.innerHTML = "";
  const ws = Number(store.profile.week_start ?? 1);
  for (let i = 0; i < 7; i++) {
    const dow = (i + ws) % 7;
    const b = el("button", "type-btn", DAYS_MIN[dow]); b.type = "button";
    b.style.padding = "10px 2px";
    b.setAttribute("aria-pressed", String(state.patternDays.has(dow)));
    b.addEventListener("click", () => {
      state.patternDays.has(dow) ? state.patternDays.delete(dow) : state.patternDays.add(dow);
      renderPatternDays(); updatePatternPreview();
    });
    wrap.appendChild(b);
  }
}

function onPatternModeChange() {
  const mode = $("pat-mode").value;
  $("pat-weekly").hidden = mode !== "weekly";
  $("pat-cycle").hidden = mode !== "cycle";
  updatePatternPreview();
}

function patternDates() {
  const mode = $("pat-mode").value;
  const from = $("pat-from").value, to = $("pat-to").value;
  if (!from || !to) return [];
  let cur = parseYmd(from);
  const end = parseYmd(to);
  if (end < cur) return [];
  const out = [];
  let guard = 0;
  if (mode === "cycle") {
    const on = Math.max(1, Number($("pat-on").value) || 1);
    const off = Math.max(0, Number($("pat-off").value) || 0);
    let i = 0;
    while (cur <= end && guard++ < 1500) {
      if (i % (on + off) < on) out.push(ymd(cur));
      cur = addDays(cur, 1); i++;
    }
  } else {
    while (cur <= end && guard++ < 1500) {
      if (mode === "every" || state.patternDays.has(cur.getDay())) out.push(ymd(cur));
      cur = addDays(cur, 1);
    }
  }
  return out;
}

function updatePatternPreview() {
  const n = patternDates().length;
  const t = store.typeById(state.patternType);
  $("pat-preview").textContent = n
    ? `Will set ${n} day${n === 1 ? "" : "s"} to “${t?.name || "—"}”. Existing shifts on those days are replaced.`
    : "No days match yet — pick a pattern and a date range.";
}

// ============================================================== settings ---
function openSettings() {
  const p = store.profile;
  $("set-sub").textContent = CLOUD_ENABLED ? "Synced to your account" : "Saved on this device";
  $("shift-alarm").value = p.shift_alarm_minutes == null ? "" : String(p.shift_alarm_minutes);
  $("week-start").value = String(p.week_start ?? 1);
  $("theme").value = p.theme || "auto";
  $("tz").value = p.timezone || "";
  $("acct-email").textContent = store.user?.email || "—";
  $("acct-mode").textContent = CLOUD_ENABLED
    ? (store.online ? "Signed in · syncing" : "Signed in · offline, changes are queued")
    : "Local mode — data lives in this browser only";
  $("version").textContent = `${APP_NAME} · build ${BUILD}`;
  renderTypeEditor();
  renderIcsBlock();
  refreshPushToggle();
  openSheet($("settings-sheet"));
}

function renderTypeEditor() {
  const list = $("type-list");
  list.innerHTML = "";
  for (const t of store.profile.shift_types) {
    const row = el("div", "type-editor");
    row.dataset.id = t.id;

    const color = document.createElement("input");
    color.type = "color"; color.value = t.color; color.dataset.k = "color";

    const name = document.createElement("input");
    name.type = "text"; name.value = t.name; name.dataset.k = "name"; name.placeholder = "Name";

    const start = document.createElement("input");
    start.type = "time"; start.value = t.start || ""; start.dataset.k = "start";

    const end = document.createElement("input");
    end.type = "time"; end.value = t.end || ""; end.dataset.k = "end";

    const del = el("button", "del", "×"); del.type = "button";
    del.setAttribute("aria-label", `Remove ${t.name}`);
    del.addEventListener("click", () => {
      const used = [...store.shifts.values()].filter((s) => s.type_id === t.id).length;
      if (used && !confirm(`${t.name} is used on ${used} day${used === 1 ? "" : "s"}. Remove it anyway? Those days keep the shift but show grey.`)) return;
      row.remove();
    });

    row.append(color, name, start, end, del);
    list.appendChild(row);
  }
}

function collectTypes() {
  const rows = [...$("type-list").children];
  const types = rows.map((row) => {
    const get = (k) => row.querySelector(`[data-k="${k}"]`).value;
    return {
      id: row.dataset.id,
      name: get("name").trim() || "Shift",
      color: get("color"),
      start: get("start"),
      end: get("end"),
    };
  });
  return types.length ? types : DEFAULT_SHIFT_TYPES.map((t) => ({ ...t }));
}

function saveSettings() {
  const tz = $("tz").value.trim();
  store.saveProfile({
    shift_types: collectTypes(),
    shift_alarm_minutes: $("shift-alarm").value === "" ? null : Number($("shift-alarm").value),
    week_start: Number($("week-start").value),
    theme: $("theme").value,
    timezone: tz || store.profile.timezone,
  });
  applyTheme();
  closeTop();
  refresh();
  toast("Settings saved");
}

function applyTheme() {
  const t = store.profile.theme || "auto";
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}

// ================================================== iPhone calendar feed ---
function icsUrls() {
  if (!CLOUD_ENABLED || !store.profile.ics_token) return null;
  const base = SUPABASE_URL.replace(/\/+$/, "");
  const https = `${base}/functions/v1/ics?token=${store.profile.ics_token}`;
  return { https, webcal: https.replace(/^https:/, "webcal:") };
}

function renderIcsBlock() {
  const urls = icsUrls();
  const block = $("ics-block");
  if (!urls) { block.hidden = true; return; }
  block.hidden = false;
  $("ics-url").value = urls.https;
  const sub = $("ics-subscribe");
  if (sub) sub.href = urls.webcal;
}

// ============================================================== web push ---
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const pushSupported = () =>
  CLOUD_ENABLED && VAPID_PUBLIC_KEY && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

async function refreshPushToggle() {
  const toggle = $("push-toggle");
  const hint = $("push-hint");
  if (!pushSupported()) {
    toggle.disabled = true; toggle.checked = false;
    hint.textContent = isIOS() && !isStandalone()
      ? "Add this to your Home Screen first (Share → Add to Home Screen), then open it from there."
      : "Not set up yet — use the iPhone Calendar option below instead.";
    return;
  }
  if (isIOS() && !isStandalone()) {
    toggle.disabled = true; toggle.checked = false;
    hint.textContent = "iPhone only allows this once the app is on your Home Screen. Share → Add to Home Screen, then open it from there.";
    return;
  }
  toggle.disabled = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    toggle.checked = !!sub && Notification.permission === "granted";
    hint.textContent = toggle.checked ? "On — reminders will buzz your phone." : "Off — turn on to get shift and event alerts.";
  } catch { toggle.checked = false; }
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

async function togglePush(on) {
  const hint = $("push-hint");
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!on) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await store.sb?.remove("push_subscriptions", `endpoint=eq.${encodeURIComponent(sub.endpoint)}`);
        await sub.unsubscribe();
      }
      hint.textContent = "Off — turn on to get shift and event alerts.";
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { $("push-toggle").checked = false; hint.textContent = "Blocked in iPhone Settings → Notifications."; return; }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    const raw = sub.toJSON();
    await store.sb.upsert("push_subscriptions", {
      user_id: store.user.id,
      endpoint: raw.endpoint,
      p256dh: raw.keys.p256dh,
      auth: raw.keys.auth,
      user_agent: navigator.userAgent.slice(0, 200),
    }, "endpoint");
    hint.textContent = "On — reminders will buzz your phone.";
    toast("Notifications on");
  } catch (err) {
    console.warn(err);
    $("push-toggle").checked = false;
    hint.textContent = "Could not turn that on: " + (err.message || err);
  }
}

// ================================================================ chrome ---
function setTitle() {
  $("mt-main").textContent = `${MONTHS[state.cursor.getMonth()]} ${state.cursor.getFullYear()}`;
  const now = new Date();
  $("mt-sub").textContent = sameMonth(state.cursor, now)
    ? `Today is ${DAYS_SHORT[now.getDay()]} ${now.getDate()}` : "";
}
const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

function renderBanner() {
  const b = $("banner"), t = $("banner-text");
  if (!CLOUD_ENABLED) {
    b.hidden = false; b.className = "banner warn";
    t.textContent = "Local mode — this calendar is only saved in this browser. Add your Supabase keys to sync and get reminders.";
  } else if (!store.online) {
    b.hidden = false; b.className = "banner warn";
    t.textContent = store.pendingCount
      ? `Offline — ${store.pendingCount} change${store.pendingCount === 1 ? "" : "s"} will upload when you're back.`
      : "Offline — you can still browse and edit.";
  } else if (store.pendingCount) {
    b.hidden = false; b.className = "banner";
    t.textContent = `Saving ${store.pendingCount} change${store.pendingCount === 1 ? "" : "s"}…`;
  } else {
    b.hidden = true;
  }
}

function refresh() {
  setTitle();
  renderWeekdays();
  renderBanner();
  if (state.view === "month") { renderMonth(); renderSummary(); }
  else renderAgenda();
}

function setView(v) {
  state.view = v;
  $("tab-month").setAttribute("aria-selected", String(v === "month"));
  $("tab-agenda").setAttribute("aria-selected", String(v === "agenda"));
  $("month-view").hidden = v !== "month";
  $("agenda-view").hidden = v !== "agenda";
  refresh();
}

// ================================================================= wiring ---
function wire() {
  $("prev").addEventListener("click", () => { state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() - 1, 1, 12); refresh(); });
  $("next").addEventListener("click", () => { state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1, 12); refresh(); });
  $("today-btn").addEventListener("click", () => { state.cursor = new Date(); state.selected = ymd(new Date()); refresh(); });
  $("month-title").addEventListener("click", () => { state.cursor = new Date(); refresh(); });
  $("tab-month").addEventListener("click", () => setView("month"));
  $("tab-agenda").addEventListener("click", () => setView("agenda"));
  $("settings-btn").addEventListener("click", openSettings);
  $("fab").addEventListener("click", () => openEvent(null));

  $("scrim").addEventListener("click", closeTop);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeTop));
  addEventListener("keydown", (e) => { if (e.key === "Escape" && stack.length) closeTop(); });

  $("day-add-event").addEventListener("click", () => openEvent(null));
  $("day-repeat").addEventListener("click", openPattern);

  $("ev-allday").addEventListener("change", syncAllDay);
  $("ev-save").addEventListener("click", saveEventFromForm);
  $("ev-delete").addEventListener("click", () => {
    if (!state.editing) return;
    if (!confirm(`Delete “${state.editing.title}”?`)) return;
    store.deleteEvent(state.editing.id);
    closeTop(); refresh();
    if (stack.includes($("day-sheet"))) renderDayBody();
    toast("Deleted");
  });

  $("pat-mode").addEventListener("change", onPatternModeChange);
  ["pat-from", "pat-to", "pat-on", "pat-off"].forEach((id) => $(id).addEventListener("change", updatePatternPreview));
  $("pat-apply").addEventListener("click", () => {
    const dates = patternDates();
    if (!dates.length) { toast("Nothing to apply"); return; }
    if (dates.length > 400) { toast("That's too many days at once"); return; }
    store.setShiftBulk(dates, state.patternType);
    closeTop(); renderDayBody(); refresh();
    toast(`${dates.length} days set`);
  });

  $("set-save").addEventListener("click", saveSettings);
  $("add-type").addEventListener("click", () => {
    const list = $("type-list");
    const row = el("div", "type-editor");
    row.dataset.id = uuid().slice(0, 8);
    row.innerHTML =
      '<input type="color" data-k="color" value="#0ea5e9">' +
      '<input type="text" data-k="name" placeholder="Name" value="New shift">' +
      '<input type="time" data-k="start"><input type="time" data-k="end">' +
      '<button type="button" class="del" aria-label="Remove">&times;</button>';
    row.querySelector(".del").addEventListener("click", () => row.remove());
    list.appendChild(row);
    row.querySelector('[data-k="name"]').select();
  });
  $("push-toggle").addEventListener("change", (e) => togglePush(e.target.checked));
  $("ics-copy").addEventListener("click", async () => {
    const url = $("ics-url").value;
    try { await navigator.clipboard.writeText(url); toast("Link copied"); }
    catch { $("ics-url").select(); document.execCommand?.("copy"); toast("Link copied"); }
  });
  $("export-btn").addEventListener("click", () => {
    const blob = new Blob([store.exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shift-calendar-backup-${ymd(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  $("signout").addEventListener("click", async () => {
    if (!confirm("Sign out on this device?")) return;
    await store.signOut();
    closeAllSheets();
  });

  // swipe left/right between months
  let sx = 0, sy = 0, tracking = false;
  const main = $("app");
  main.addEventListener("touchstart", (e) => {
    if (stack.length || e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  main.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) {
      state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + (dx < 0 ? 1 : -1), 1, 12);
      refresh();
    }
  }, { passive: true });

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("login-btn"), err = $("login-error");
    err.hidden = true; btn.disabled = true; btn.textContent = "Signing in…";
    try {
      await store.signIn($("email").value, $("password").value);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = "Sign in";
    }
  });
}

// =================================================================== boot ---
function showApp() {
  $("boot").hidden = true;
  const signedIn = !!store.user;
  $("login").hidden = signedIn;
  $("app").hidden = !signedIn;
  if (signedIn) { applyTheme(); refresh(); }
}

function main() {
  // ---- critical path: everything here is synchronous, so the calendar is on
  // ---- screen before a single network request goes out.
  wire();
  if (CLOUD_ENABLED) {
    // Warm the DNS + TLS handshake to Supabase while the page is still painting.
    const pc = document.createElement("link");
    pc.rel = "preconnect"; pc.href = SUPABASE_URL; pc.crossOrigin = "anonymous";
    document.head.appendChild(pc);
  } else {
    $("login-sub").textContent = "Not connected to a server yet — you'll get a local-only calendar.";
  }

  store.on("auth", showApp);
  store.on("change", () => { if (store.user && !$("app").hidden) refresh(); });
  store.on("sync", renderBanner);

  store.bootLocal();
  showApp();

  // Deep link from a notification: ?date=2026-09-12
  const jump = new URLSearchParams(location.search).get("date");
  if (jump && /^\d{4}-\d{2}-\d{2}$/.test(jump) && store.user) {
    state.cursor = parseYmd(jump); refresh(); openDay(jump);
    history.replaceState(null, "", location.pathname);
  }

  // ---- everything below touches the network; none of it blocks the paint.
  store.connect();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) store.sync(); });

  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 800));
  idle(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((e) => console.warn("sw:", e));

    // Pages are served cache-first, so a freshly deployed version would
    // otherwise only appear on the load *after* next. Refresh when the worker
    // says the files genuinely changed — but never mid-edit, and only once.
    let reloaded = false;
    const refresh = () => {
      if (reloaded) return;
      if (stack.length) return;          // a sheet is open; she's in the middle of something
      reloaded = true;
      location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", refresh);
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "sc-updated") refresh();
    });
  });
}

main();
