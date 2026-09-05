// ===========================================================================
//  store.js — data layer
//
//  Three jobs:
//    1. Talk to Supabase (auth + Postgres), where the real copy of the data lives.
//    2. Keep a mirror in localStorage so the calendar paints instantly, with no
//       network at all, every time she opens it.
//    3. Queue any change made while offline and replay it once she's back.
//
//  Boot order matters for speed: bootLocal() is synchronous and gives the UI
//  everything it needs to draw. Only then does connect() touch the network.
// ===========================================================================

import { SUPABASE_URL, SUPABASE_ANON_KEY, CLOUD_ENABLED, DEFAULT_TIMEZONE } from "./config.js";
import { Supa } from "./sb.js";

export const DEFAULT_SHIFT_TYPES = [
  { id: "morning", name: "Morning", color: "#f59e0b", start: "07:00", end: "15:00" },
  { id: "evening", name: "Evening", color: "#8b5cf6", start: "15:00", end: "23:00" },
  { id: "night",   name: "Night",   color: "#4c1d95", start: "23:00", end: "07:00" },
  { id: "oncall",  name: "On-call", color: "#ec4899", start: "",      end: ""      },
  { id: "off",     name: "Off",     color: "#94a3b8", start: "",      end: ""      },
  { id: "leave",   name: "Leave",   color: "#10b981", start: "",      end: ""      },
];

const DEFAULT_PROFILE = () => ({
  shift_types: DEFAULT_SHIFT_TYPES.map((t) => ({ ...t })),
  week_start: 1,
  theme: "auto",
  timezone: DEFAULT_TIMEZONE,
  shift_alarm_minutes: 120,
  ics_token: null,
});

export const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });

const LS = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v)  { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k)     { try { localStorage.removeItem(k); } catch {} },
};

class DataStore extends EventTarget {
  constructor() {
    super();
    this.sb = null;
    this.user = null;
    this.cloud = CLOUD_ENABLED;
    this.online = navigator.onLine;
    this.syncing = false;
    this.ready = false;          // true once a server round-trip has landed
    this.shifts = new Map();
    this.events = [];
    this.profile = DEFAULT_PROFILE();
    this.outbox = [];
    this._poll = null;

    addEventListener("online",  () => { this.online = true;  this.emit("sync"); this.sync(); });
    addEventListener("offline", () => { this.online = false; this.emit("sync"); });
  }

  emit(type = "change") { this.dispatchEvent(new Event(type)); }
  on(type, fn) { this.addEventListener(type, fn); }

  get cacheKey()  { return `sc.cache.${this.user?.id || "anon"}`; }
  get outboxKey() { return `sc.outbox.${this.user?.id || "anon"}`; }

  // -------------------------------------------------------------- boot ---
  /**
   * Synchronous. Reads the session and the cached calendar out of
   * localStorage so the first paint needs zero network. Returns true if we
   * already know who she is and can draw the calendar right now.
   */
  bootLocal() {
    if (this.cloud) {
      this.sb = new Supa(SUPABASE_URL, SUPABASE_ANON_KEY);
      this.sb.onSignedOut = () => { this.user = null; this.emit("auth"); };
      if (this.sb.user?.id) { this.user = this.sb.user; this._loadCache(); }
    } else {
      this.user = { id: "local", email: "This device only" };
      this._loadCache();
    }
    return !!this.user;
  }

  /** Everything that needs the network. Never blocks the first paint. */
  async connect() {
    if (!this.cloud || !this.user) { this.ready = true; return; }
    await this.sync();
    this._startPolling();
  }

  _startPolling() {
    // Cheap stand-in for realtime: refresh while the app is actually on screen.
    clearInterval(this._poll);
    this._poll = setInterval(() => {
      if (!document.hidden && this.online && !this.syncing) this._pull().then(() => this.emit()).catch(() => {});
    }, 90_000);
  }

  // -------------------------------------------------------------- auth ---
  async signIn(email, password) {
    if (!this.cloud) {
      this.user = { id: "local", email: "This device only" };
      this._loadCache(); this.emit("auth");
      return;
    }
    const user = await this.sb.signIn(email.trim(), password);
    this.user = user;
    this._loadCache();
    this.emit("auth");
    await this.sync();
    this._startPolling();
  }

  async signOut() {
    const ck = this.cacheKey, ok = this.outboxKey;
    clearInterval(this._poll);
    try { await this.sb?.signOut(); } catch {}
    LS.del(ck); LS.del(ok);
    this.user = null; this.shifts = new Map(); this.events = []; this.profile = DEFAULT_PROFILE();
    this.ready = false;
    this.emit("auth");
  }

  // ------------------------------------------------------------- cache ---
  _loadCache() {
    const c = LS.get(this.cacheKey, null);
    if (c) {
      this.shifts = new Map((c.shifts || []).map((s) => [s.date, s]));
      this.events = c.events || [];
      this.profile = { ...DEFAULT_PROFILE(), ...(c.profile || {}) };
    }
    this.outbox = LS.get(this.outboxKey, []);
  }

  _saveCache() {
    LS.set(this.cacheKey, {
      shifts: [...this.shifts.values()],
      events: this.events,
      profile: this.profile,
      at: Date.now(),
    });
  }

  _saveOutbox() { LS.set(this.outboxKey, this.outbox); }

  // -------------------------------------------------------------- sync ---
  async sync() {
    if (!this.cloud || !this.sb || !this.user || this.syncing || !this.online) return;
    this.syncing = true; this.emit("sync");
    try {
      await this._flushOutbox();
      await this._pull();
      this.ready = true;
    } catch (err) {
      console.warn("sync failed:", err);
    } finally {
      this.syncing = false;
      this.emit("sync"); this.emit();
    }
  }

  async _pull() {
    const [shifts, events, profiles] = await Promise.all([
      this.sb.select("shifts", "select=*"),
      this.sb.select("events", "select=*"),
      this.sb.select("profiles", `select=*&user_id=eq.${this.user.id}&limit=1`),
    ]);

    this.shifts = new Map((shifts || []).map((s) => [s.date, s]));
    this.events = events || [];

    const p = profiles?.[0];
    if (p) {
      const missingTypes = !Array.isArray(p.shift_types) || !p.shift_types.length;
      this.profile = {
        ...DEFAULT_PROFILE(),
        ...p,
        shift_types: missingTypes ? DEFAULT_SHIFT_TYPES.map((t) => ({ ...t })) : p.shift_types,
      };
      // The row exists but has no shift types (an older signup, or the trigger
      // created it bare). Write the defaults back, or the .ics feed would label
      // every shift with its raw id instead of "Morning" / "Night".
      if (missingTypes) this.saveProfile({ shift_types: this.profile.shift_types });
    } else {
      // ics_token is NOT NULL with a generated default, so it must not be sent.
      const { ics_token, ...row } = { ...DEFAULT_PROFILE(), user_id: this.user.id };
      const created = await this.sb.insert("profiles", row).catch(() => null);
      if (created?.[0]) this.profile = { ...DEFAULT_PROFILE(), ...created[0] };
    }
    this._saveCache();
  }

  async _flushOutbox() {
    while (this.outbox.length) {
      const job = this.outbox[0];
      if (job.op === "upsert")      await this.sb.upsert(job.table, job.row, job.conflict || "id");
      else if (job.op === "delete") await this.sb.remove(job.table, `id=eq.${job.id}`);
      this.outbox.shift();
      this._saveOutbox();
    }
  }

  _queue(job) {
    this.outbox.push(job);
    this._saveOutbox();
    if (this.online && this.cloud) this.sync();
  }

  // ------------------------------------------------------------ shifts ---
  getShift(date) { return this.shifts.get(date) || null; }

  setShift(date, patch) {
    const existing = this.shifts.get(date);
    const row = {
      id: existing?.id || uuid(),
      user_id: this.user.id,
      date,
      type_id: patch.type_id ?? existing?.type_id ?? null,
      start_time: patch.start_time !== undefined ? patch.start_time || null : existing?.start_time ?? null,
      end_time:   patch.end_time   !== undefined ? patch.end_time   || null : existing?.end_time   ?? null,
      unit:       patch.unit       !== undefined ? patch.unit       || null : existing?.unit       ?? null,
      notes:      patch.notes      !== undefined ? patch.notes      || null : existing?.notes      ?? null,
      reminder_sent_at: null,
      updated_at: new Date().toISOString(),
    };
    this.shifts.set(date, row);
    this._saveCache(); this.emit();
    if (this.cloud) this._queue({ op: "upsert", table: "shifts", row, conflict: "user_id,date" });
  }

  clearShift(date) {
    const existing = this.shifts.get(date);
    if (!existing) return;
    this.shifts.delete(date);
    this._saveCache(); this.emit();
    if (this.cloud) this._queue({ op: "delete", table: "shifts", id: existing.id });
  }

  /** Bulk-assign a shift type across many dates (the repeat tool). */
  setShiftBulk(dates, typeId) {
    const rows = [];
    for (const date of dates) {
      const existing = this.shifts.get(date);
      // A per-day time override only means something for the type it was set
      // on. Painting a different shift over the day must drop it, or a "Night"
      // could silently inherit a morning's 08:00-20:00 and skew the hours.
      const sameType = existing?.type_id === typeId;
      const row = {
        id: existing?.id || uuid(),
        user_id: this.user.id,
        date,
        type_id: typeId,
        start_time: sameType ? existing?.start_time ?? null : null,
        end_time: sameType ? existing?.end_time ?? null : null,
        unit: existing?.unit ?? null,
        notes: existing?.notes ?? null,
        reminder_sent_at: null,
        updated_at: new Date().toISOString(),
      };
      this.shifts.set(date, row);
      rows.push(row);
    }
    this._saveCache(); this.emit();
    if (this.cloud && rows.length) this._queue({ op: "upsert", table: "shifts", row: rows, conflict: "user_id,date" });
    return rows.length;
  }

  // ------------------------------------------------------------ events ---
  eventsOn(date) {
    return this.events
      .filter((e) => e.date === date)
      .sort((a, b) => (a.all_day ? "" : a.start_time || "").localeCompare(b.all_day ? "" : b.start_time || ""));
  }

  saveEvent(ev) {
    const row = {
      id: ev.id || uuid(),
      user_id: this.user.id,
      title: (ev.title || "").trim() || "Untitled",
      date: ev.date,
      all_day: !!ev.all_day,
      start_time: ev.all_day ? null : ev.start_time || null,
      end_time: ev.all_day ? null : ev.end_time || null,
      location: ev.location || null,
      notes: ev.notes || null,
      color: ev.color || "#7c3aed",
      remind_minutes: ev.remind_minutes === "" || ev.remind_minutes == null ? null : Number(ev.remind_minutes),
      reminder_sent_at: null,
      updated_at: new Date().toISOString(),
    };
    const i = this.events.findIndex((e) => e.id === row.id);
    if (i >= 0) this.events[i] = row; else this.events.push(row);
    this._saveCache(); this.emit();
    if (this.cloud) this._queue({ op: "upsert", table: "events", row });
    return row;
  }

  deleteEvent(id) {
    this.events = this.events.filter((e) => e.id !== id);
    this._saveCache(); this.emit();
    if (this.cloud) this._queue({ op: "delete", table: "events", id });
  }

  // ----------------------------------------------------------- profile ---
  saveProfile(patch) {
    this.profile = { ...this.profile, ...patch };
    this._saveCache(); this.emit();
    if (this.cloud) {
      this._queue({
        op: "upsert", table: "profiles", conflict: "user_id",
        row: {
          user_id: this.user.id,
          shift_types: this.profile.shift_types,
          week_start: this.profile.week_start,
          theme: this.profile.theme,
          timezone: this.profile.timezone,
          shift_alarm_minutes: this.profile.shift_alarm_minutes,
        },
      });
    }
  }

  typeById(id) {
    return this.profile.shift_types.find((t) => t.id === id)
        || (id ? { id, name: id, color: "#94a3b8", start: "", end: "" } : null);
  }

  // ----------------------------------------------------------- exports ---
  exportJson() {
    return JSON.stringify({
      exported_at: new Date().toISOString(),
      profile: this.profile,
      shifts: [...this.shifts.values()],
      events: this.events,
    }, null, 2);
  }

  get pendingCount() { return this.outbox.length; }
}

export const store = new DataStore();
