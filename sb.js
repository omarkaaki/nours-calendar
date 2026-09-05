// ===========================================================================
//  sb.js — a very small Supabase client.
//
//  The official @supabase/supabase-js is ~120 KB and pulls six separate files
//  off a CDN before the app can boot. This calendar only needs password login,
//  token refresh, and four REST verbs, which is about 150 lines. Writing them
//  by hand keeps the whole app under ~15 KB gzipped and removes every
//  third-party origin from the critical path.
//
//  Nothing here weakens security: the anon key and the access token are used
//  exactly as the official library uses them, and Row Level Security in
//  Postgres is what actually protects the rows.
// ===========================================================================

const SESSION_KEY = "sc.session";
const SKEW_SECONDS = 90;   // refresh this long before the token actually expires

export class AuthError extends Error {}

export class Supa {
  constructor(url, anonKey) {
    this.url = String(url).replace(/\/+$/, "");
    this.key = anonKey;
    this.session = readSession();
    this._refreshing = null;
    this.onSignedOut = () => {};
  }

  get user() { return this.session?.user || null; }

  // ------------------------------------------------------------------ auth
  async signIn(email, password) {
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: this.key, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new AuthError(authMessage(data, res.status));
    this._store(data);
    return this.session.user;
  }

  async signOut() {
    const token = this.session?.access_token;
    this._clear();
    if (token) {
      // Best effort — the local session is already gone either way.
      fetch(`${this.url}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: this.key, Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
  }

  /** A valid access token, refreshing first if it is about to expire. */
  async token() {
    if (!this.session) return null;
    const now = Math.floor(Date.now() / 1000);
    if (this.session.expires_at - SKEW_SECONDS > now) return this.session.access_token;
    return this._refresh();
  }

  async _refresh() {
    if (this._refreshing) return this._refreshing;
    const refresh_token = this.session?.refresh_token;
    if (!refresh_token) { this._clear(); return null; }

    this._refreshing = (async () => {
      try {
        const res = await fetch(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { apikey: this.key, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token }),
        });
        if (!res.ok) {
          // 400/401 means the refresh token is dead — a real sign-out.
          if (res.status === 400 || res.status === 401) { this._clear(); this.onSignedOut(); return null; }
          throw new Error(`refresh failed (${res.status})`);
        }
        const data = await res.json();
        this._store(data);
        return this.session.access_token;
      } finally {
        this._refreshing = null;
      }
    })();

    return this._refreshing;
  }

  _store(data) {
    const expires_at = data.expires_at
      ?? Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600);
    this.session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at,
      user: { id: data.user?.id, email: data.user?.email },
    };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(this.session)); } catch {}
  }

  _clear() {
    this.session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  }

  // ------------------------------------------------------------------ rest
  async _req(path, init = {}, retry = true) {
    const token = await this.token();
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.key,
        // Only send a Bearer when we hold a real user JWT. Falling back to the
        // API key here would break the newer sb_publishable_* keys, which are
        // not JWTs and make PostgREST reject the request outright.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });

    if (res.status === 401 && retry && this.session) {
      // Token rejected mid-flight; force one refresh and try again.
      this.session.expires_at = 0;
      const fresh = await this._refresh();
      if (fresh) return this._req(path, init, false);
    }
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = j.message || j.hint || j.error_description || ""; } catch {}
      throw new Error(detail || `Request failed (${res.status})`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  select(table, query = "select=*") { return this._req(`${table}?${query}`); }

  insert(table, row, { returning = true } = {}) {
    return this._req(table, {
      method: "POST",
      headers: { Prefer: returning ? "return=representation" : "return=minimal" },
      body: JSON.stringify(row),
    });
  }

  upsert(table, rows, onConflict = "id") {
    return this._req(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
  }

  patch(table, filter, body) {
    return this._req(`${table}?${filter}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
  }

  remove(table, filter) {
    return this._req(`${table}?${filter}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  }
}

function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return s?.access_token && s?.refresh_token ? s : null;
  } catch { return null; }
}

function authMessage(data, status) {
  const raw = String(data.error_description || data.msg || data.message || data.error || "").toLowerCase();
  if (raw.includes("invalid login") || raw.includes("invalid_grant")) return "That email or password isn't right.";
  if (raw.includes("email not confirmed")) return "This account hasn't been confirmed yet.";
  if (raw.includes("rate") || status === 429) return "Too many attempts. Wait a minute and try again.";
  if (status === 0) return "No connection. Try again when you have signal.";
  return data.error_description || data.msg || data.message || "Could not sign in.";
}
