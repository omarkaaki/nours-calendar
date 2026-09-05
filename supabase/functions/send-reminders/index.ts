// ===========================================================================
//  Edge function: send-reminders
//
//  Runs once a minute (pg_cron calls it). Finds shifts and events whose
//  reminder time has just arrived and pushes a notification to every device
//  the user has registered.
//
//  Deploy with "Verify JWT" OFF — it authenticates with the CRON_SECRET header
//  instead, so no user token is involved.
//
//  Secrets to set (Edge Functions -> Secrets):
//    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET
// ===========================================================================

import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:nobody@example.com";

// How late a reminder may be and still be worth sending (cron hiccups, cold starts).
const GRACE_MINUTES = 25;

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------- timezone ----
function tzOffsetMs(at: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - at.getTime();
}
function zonedToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = (timeStr || "00:00").split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ts = naive - tzOffsetMs(new Date(naive), tz);
  ts = naive - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}
const pad = (n: number) => String(n).padStart(2, "0");
const dayStr = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function prettyTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h < 12 ? "am" : "pm";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${pad(m)}${ampm}` : `${hh}${ampm}`;
}
function relative(mins: number) {
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins} minutes`;
  if (mins < 1440) { const h = Math.round(mins / 60); return `in ${h} hour${h === 1 ? "" : "s"}`; }
  const d = Math.round(mins / 1440);
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

// ----------------------------------------------------------------- push ----
async function pushToUser(subs: any[], payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 3600, urgency: "high" },
      );
      sent++;
    } catch (err: any) {
      const code = err?.statusCode;
      // 404/410 mean the browser threw the subscription away — clean it up.
      if (code === 404 || code === 410) {
        await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" })
          .catch(() => {});
      } else {
        console.error("push failed", code, err?.body ?? err?.message);
      }
    }
  }
  return sent;
}

// -------------------------------------------------------------- handler ----
Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return new Response(JSON.stringify({ error: "VAPID keys not configured" }), { status: 500 });
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - GRACE_MINUTES * 60_000);
  const from = dayStr(new Date(now.getTime() - 2 * 86400_000));
  const to   = dayStr(new Date(now.getTime() + 4 * 86400_000));

  const [profiles, events, shifts] = await Promise.all([
    rest(`profiles?select=user_id,timezone,shift_types,shift_alarm_minutes`),
    rest(`events?remind_minutes=not.is.null&reminder_sent_at=is.null&date=gte.${from}&date=lte.${to}&select=*`),
    rest(`shifts?type_id=not.is.null&reminder_sent_at=is.null&date=gte.${from}&date=lte.${to}&select=*`),
  ]);

  const byUser = new Map<string, any>(profiles.map((p: any) => [p.user_id, p]));
  const subsCache = new Map<string, any[]>();
  const subsFor = async (uid: string) => {
    if (!subsCache.has(uid)) subsCache.set(uid, await rest(`push_subscriptions?user_id=eq.${uid}&select=*`));
    return subsCache.get(uid)!;
  };

  const results = { events: 0, shifts: 0, skipped: 0 };

  // ---- event reminders ----
  for (const e of events) {
    const p = byUser.get(e.user_id);
    if (!p) continue;
    const tz = p.timezone || "UTC";
    const startAt = zonedToUtc(e.date, e.all_day || !e.start_time ? "09:00" : e.start_time.slice(0, 5), tz);
    const fireAt = new Date(startAt.getTime() - (e.remind_minutes ?? 0) * 60_000);
    if (fireAt > now || fireAt < windowStart) { results.skipped++; continue; }

    const minsAway = Math.round((startAt.getTime() - now.getTime()) / 60_000);
    const when = e.all_day || !e.start_time ? "today" : `at ${prettyTime(e.start_time.slice(0, 5))}`;
    const bits = [e.all_day || !e.start_time ? when : `${when} · ${relative(minsAway)}`];
    if (e.location) bits.push(e.location);

    await pushToUser(await subsFor(e.user_id), {
      title: e.title, body: bits.join(" — "), tag: `event-${e.id}`, date: e.date,
    });
    await rest(`events?id=eq.${e.id}`, { method: "PATCH", body: JSON.stringify({ reminder_sent_at: now.toISOString() }) });
    results.events++;
  }

  // ---- shift reminders ----
  for (const s of shifts) {
    const p = byUser.get(s.user_id);
    if (!p || p.shift_alarm_minutes == null) continue;
    const tz = p.timezone || "UTC";
    const type = (p.shift_types || []).find((t: any) => t.id === s.type_id) ?? { name: s.type_id, start: "" };
    const start = s.start_time?.slice(0, 5) || type.start || "";
    if (!start) continue;                       // untimed (Off / Leave) — nothing to warn about

    const startAt = zonedToUtc(s.date, start, tz);
    const fireAt = new Date(startAt.getTime() - p.shift_alarm_minutes * 60_000);
    if (fireAt > now || fireAt < windowStart) { results.skipped++; continue; }

    const minsAway = Math.round((startAt.getTime() - now.getTime()) / 60_000);
    const bits = [`Starts ${prettyTime(start)} — ${relative(minsAway)}`];
    if (s.unit) bits.push(s.unit);

    const badge = [type.emoji, s.emoji].filter(Boolean).join("");
    await pushToUser(await subsFor(s.user_id), {
      title: `${badge ? badge + " " : ""}${type.name} shift`,
      body: bits.join(" · "), tag: `shift-${s.id}`, date: s.date,
    });
    await rest(`shifts?id=eq.${s.id}`, { method: "PATCH", body: JSON.stringify({ reminder_sent_at: now.toISOString() }) });
    results.shifts++;
  }

  return new Response(JSON.stringify({ ok: true, at: now.toISOString(), ...results }), {
    headers: { "Content-Type": "application/json" },
  });
});
