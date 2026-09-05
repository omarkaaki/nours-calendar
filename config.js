// ---------------------------------------------------------------------------
//  CONFIG  —  this is the only file you need to edit after setting up Supabase.
//  Everything here is *public* (it ships to the browser). That is fine and by
//  design: the anon key can only ever read/write rows that belong to the person
//  who is logged in, because Row Level Security is enforced by the database.
// ---------------------------------------------------------------------------

export const SUPABASE_URL = "https://satxmwaythodwkntfowg.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_hIaqfxP3EwVYbEy1dMQNZQ_gFUYcGgH";

// Optional — only needed for Web Push (Tier 2 in the README).
// Leave empty and the app simply hides the push toggle.
export const VAPID_PUBLIC_KEY = "";

// Her timezone. Used for reminders and the iPhone calendar feed.
export const DEFAULT_TIMEZONE = "Asia/Beirut";

// Cosmetic
export const APP_NAME = "Nour’s Calendar";

export const CLOUD_ENABLED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
