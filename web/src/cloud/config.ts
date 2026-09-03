/**
 * Supabase project config, read from environment variables at build time.
 *
 * Cloud backup is entirely optional. Leave these unset and the app works as a
 * purely local, offline dashboard — the cloud panel simply doesn't appear.
 *
 * To enable it, copy `.env.example` to `.env` and fill in your own project's
 * values (see docs/cloud-setup.md). The anon/publishable key is designed to
 * ship in the client bundle; your data is protected by the row-level security
 * policies in docs/supabase-schema.sql, not by keeping that key secret.
 *
 * Never put the `service_role` key here — it bypasses row-level security.
 */

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

/** True only when both values look like a real Supabase project. */
export const cloudConfigured =
  /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(SUPABASE_URL) &&
  (SUPABASE_ANON_KEY.startsWith("eyJ") || SUPABASE_ANON_KEY.startsWith("sb_publishable_"));
