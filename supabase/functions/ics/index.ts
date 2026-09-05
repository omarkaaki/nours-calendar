// ===========================================================================
//  Edge function: ics
//
//  Serves one person's calendar as an .ics feed that the iPhone Calendar app
//  can subscribe to. iOS then fires native alerts for shifts and events, even
//  when the web app is closed.
//
//  Auth is the secret token in the query string, because iOS cannot send an
//  Authorization header on a subscribed calendar. Deploy this function with
//  "Verify JWT" turned OFF.
//
//    GET /functions/v1/ics?token=<uuid from profiles.ics_token>
// ===========================================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CAL_NAME = Deno.env.get("ICS_CALENDAR_NAME") ?? "Shifts";
const MONTHS_BACK = 6;
const MONTHS_AHEAD = 18;

async function rest(path: string): Promise<any[]> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// -------------------------------------------------------------- timezone ---
/** Offset, in ms, of `tz` from UTC at the given instant. */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).reduce<Record<string, string>>((a, p) => (a[p.type] = p.value, a), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - at.getTime();
}

/** Wall-clock time in `tz` -> the real UTC instant. */
function zonedToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = (timeStr || "00:00").split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ts = naive - tzOffsetMs(new Date(naive), tz);
  ts = naive - tzOffsetMs(new Date(ts), tz);   // second pass settles DST edges
  return new Date(ts);
}

// ------------------------------------------------------------ ics helpers ---
const pad = (n: number) => String(n).padStart(2, "0");
const utcStamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const dateStamp = (s: string) => s.replaceAll("-", "");

const esc = (s: unknown) =>
  String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** RFC 5545 says fold lines at 75 octets. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    const limit = out.length === 0 ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    // do not split a multi-byte character
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(new TextDecoder().decode(bytes.subarray(start, end)));
    start = end;
  }
  return out.join("\r\n ");
}

const addDaysStr = (s: string, n: number) => {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};

const overnight = (start: string, end: string) => {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return eh * 60 + em <= sh * 60 + sm;
};

// ------------------------------------------------------------------ handler
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
  }
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
    return new Response("Missing or malformed token", { status: 400 });
  }

  let profile: any;
  try {
    const rows = await rest(`profiles?ics_token=eq.${token}&select=user_id,timezone,shift_types,shift_alarm_minutes&limit=1`);
    profile = rows[0];
  } catch (err) {
    console.error(err);
    return new Response("Server error", { status: 500 });
  }
  if (!profile) return new Response("Not found", { status: 404 });

  const tz = profile.timezone || "UTC";
  const types = new Map<string, any>((profile.shift_types || []).map((t: any) => [t.id, t]));
  const alarm = profile.shift_alarm_minutes;

  const now = new Date();
  const from = new Date(now); from.setMonth(from.getMonth() - MONTHS_BACK);
  const to   = new Date(now); to.setMonth(to.getMonth() + MONTHS_AHEAD);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr   = to.toISOString().slice(0, 10);

  const [shifts, events] = await Promise.all([
    rest(`shifts?user_id=eq.${profile.user_id}&date=gte.${fromStr}&date=lte.${toStr}&select=*`),
    rest(`events?user_id=eq.${profile.user_id}&date=gte.${fromStr}&date=lte.${toStr}&select=*`),
  ]);

  const stamp = utcStamp(now);
  const L: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Shift Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(CAL_NAME)}`,
    `X-WR-TIMEZONE:${esc(tz)}`,
    "X-PUBLISHED-TTL:PT15M",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
  ];

  const alarmBlock = (mins: number, text: string) => [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(text)}`,
    `TRIGGER:${mins === 0 ? "PT0S" : `-PT${mins >= 60 && mins % 60 === 0 ? `${mins / 60}H` : `${mins}M`}`}`,
    "END:VALARM",
  ];

  // ---- shifts ----
  for (const s of shifts) {
    if (!s.type_id) continue;
    const t = types.get(s.type_id) ?? { name: s.type_id, start: "", end: "" };
    const start = s.start_time?.slice(0, 5) || t.start || "";
    const end   = s.end_time?.slice(0, 5)   || t.end   || "";
    const title = s.unit ? `${t.name} — ${s.unit}` : t.name;

    L.push("BEGIN:VEVENT", `UID:shift-${s.id}@shift-calendar`, `DTSTAMP:${stamp}`);
    if (s.updated_at) L.push(`LAST-MODIFIED:${utcStamp(new Date(s.updated_at))}`);

    if (start && end) {
      const dtStart = zonedToUtc(s.date, start, tz);
      const endDate = overnight(start, end) ? addDaysStr(s.date, 1) : s.date;
      const dtEnd = zonedToUtc(endDate, end, tz);
      L.push(`DTSTART:${utcStamp(dtStart)}`, `DTEND:${utcStamp(dtEnd)}`);
      if (alarm != null) L.push(...alarmBlock(alarm, `${title} starts soon`));
    } else {
      L.push(`DTSTART;VALUE=DATE:${dateStamp(s.date)}`, `DTEND;VALUE=DATE:${dateStamp(addDaysStr(s.date, 1))}`);
      L.push("X-MICROSOFT-CDO-ALLDAYEVENT:TRUE");
    }

    L.push(`SUMMARY:${esc(title)}`);
    if (s.notes) L.push(`DESCRIPTION:${esc(s.notes)}`);
    L.push("CATEGORIES:Shift", "TRANSP:OPAQUE", "END:VEVENT");
  }

  // ---- events ----
  for (const e of events) {
    L.push("BEGIN:VEVENT", `UID:event-${e.id}@shift-calendar`, `DTSTAMP:${stamp}`);
    if (e.updated_at) L.push(`LAST-MODIFIED:${utcStamp(new Date(e.updated_at))}`);

    if (e.all_day || !e.start_time) {
      L.push(`DTSTART;VALUE=DATE:${dateStamp(e.date)}`, `DTEND;VALUE=DATE:${dateStamp(addDaysStr(e.date, 1))}`);
      L.push("X-MICROSOFT-CDO-ALLDAYEVENT:TRUE");
    } else {
      const start = e.start_time.slice(0, 5);
      const end = e.end_time?.slice(0, 5) || null;
      const dtStart = zonedToUtc(e.date, start, tz);
      const dtEnd = end
        ? zonedToUtc(overnight(start, end) ? addDaysStr(e.date, 1) : e.date, end, tz)
        : new Date(dtStart.getTime() + 60 * 60 * 1000);
      L.push(`DTSTART:${utcStamp(dtStart)}`, `DTEND:${utcStamp(dtEnd)}`);
    }

    L.push(`SUMMARY:${esc(e.title)}`);
    if (e.location) L.push(`LOCATION:${esc(e.location)}`);
    if (e.notes) L.push(`DESCRIPTION:${esc(e.notes)}`);
    if (e.remind_minutes != null) L.push(...alarmBlock(e.remind_minutes, e.title));
    L.push("TRANSP:OPAQUE", "END:VEVENT");
  }

  L.push("END:VCALENDAR");

  return new Response(L.map(fold).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="shifts.ics"`,
      "Cache-Control": "no-cache, max-age=0",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
