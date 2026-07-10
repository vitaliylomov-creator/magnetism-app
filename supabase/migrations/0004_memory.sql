-- Sprint 4: memory profile.
-- Two RLS delete policies so a signed-in user can clear their own history
-- and memory profile via the "Clear memory" button in the dashboard,
-- without going through a service-role edge function. Per Project
-- Definition §9: user can wipe history with explicit confirmation.
--
-- safety_incidents are NOT deletable by the user — they exist for consultant
-- audit (Technical Brief §7). If the user later fully deletes their account,
-- the FK's `on delete set null` (migration 0001) preserves the audit trail
-- without keeping PII linkage.

create policy "conversations delete own"
  on public.conversations for delete
  using (auth.uid() = user_id);

create policy "memory_profiles delete own"
  on public.memory_profiles for delete
  using (auth.uid() = user_id);

-- ────────────────────────────────────────────────────────────────────────
-- Cron schedule (documented, NOT enabled here).
-- ────────────────────────────────────────────────────────────────────────
-- Per Technical Brief §10 / Project Definition §9: memory profiles are
-- regenerated every 6 months, not on every reply. Enabling requires the
-- pg_cron and pg_net extensions and a place to hold the service role key
-- (Supabase Vault). Below is the pattern to use when we're ready to wire
-- it, kept in the migration file as documentation so it lives with the
-- code that uses it.
--
-- 1. Enable extensions once (run in SQL editor, not in this migration
--    so we don't force them on setups that don't need them yet):
--       create extension if not exists pg_cron;
--       create extension if not exists pg_net;
--
-- 2. Store the service role key in Vault:
--       select vault.create_secret('SERVICE_ROLE_KEY', '<sk...>');
--
-- 3. Schedule the biannual refresh:
--       select cron.schedule(
--         'refresh-memory-profiles',
--         '0 3 1 */6 *',   -- 03:00 UTC on the 1st, every 6 months
--         $cron$
--         select net.http_post(
--           url := 'https://ocsrmgneyttdkingkiev.supabase.co/functions/v1/magnetism-memory-refresh',
--           headers := jsonb_build_object(
--             'Content-Type', 'application/json',
--             'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'SERVICE_ROLE_KEY')
--           ),
--           body := jsonb_build_object('cron', true)
--         );
--         $cron$
--       );
--
-- Until this is enabled, refresh is invoked manually from CLI with the
-- service role JWT as bearer. The endpoint itself is idempotent and
-- skips freshly-updated profiles unless force=true.
