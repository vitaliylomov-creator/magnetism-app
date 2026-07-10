// ────────────────────────────────────────────────────────────────────────────
// magnetism-memory-refresh — Sprint 4 memory profile generator
// ────────────────────────────────────────────────────────────────────────────
//
// Per Technical Brief §4: memory_profiles is a curated summary, not a raw
// log. Sonnet reads a user's last N non-flagged entries and writes a
// concise pattern-focused profile that magnetism-chat then injects into
// the system prompt for future replies. Regenerated infrequently (spec
// says every 6 months), so this endpoint is not called from the chat
// hot path.
//
// Deploy:
//   supabase functions deploy magnetism-memory-refresh --project-ref ocsrmgneyttdkingkiev
//
// Invoke (admin-only, from CLI):
//   curl -X POST https://ocsrmgneyttdkingkiev.supabase.co/functions/v1/magnetism-memory-refresh \
//     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
//     -H "Content-Type: application/json" \
//     -d '{}'                             # refresh all eligible users
//     -d '{"user_id": "<uuid>"}'          # refresh one user
//     -d '{"user_id": "<uuid>", "force": true}'  # skip freshness check
//
// Auth: config.toml sets verify_jwt = false. Function itself requires
// the caller's bearer to pass supabase.auth.admin.listUsers, a service-
// role-only endpoint.
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const MODEL = "claude-sonnet-4-6";
const MIN_ENTRIES_FOR_PROFILE = 5;
const MAX_ENTRIES_TO_SUMMARIZE = 50;
const REFRESH_INTERVAL_MONTHS = 6;

const MEMORY_INSTRUCTION = `You will receive a chronological sequence of diary entries written by one person. Write a concise pattern-focused memory profile of this person that will be injected into another AI's system prompt so it can respond to their future entries more personally.

Rules, strict:

Voice and format:
- Prose paragraphs. Two to four short paragraphs, total length 150 to 300 words.
- Written in third person about the person, addressed to the next AI: "This person tends to...", "Across their entries you can hear...". Do not address the person directly ("you") anywhere in the profile.
- Language: whichever language the entries were primarily written in. If they are mixed English and Ukrainian, use the language that appears in the majority of entries.

Content, include:
- Recurring patterns visible across multiple entries, not one-off content.
- Specific vocabulary or metaphors the person uses for themselves (for example: "стопор", "leak-ціна", "the discount before anyone asks"). Quote short specific phrases they used, in the language they used them.
- The general kinds of situations they bring here: professional, creative, relational, physical.
- What they seem to be working on across entries, if there is a through-line.
- How they respond to being told the truth: do they resist, integrate, deflect, come back to the same theme.
- What tone lands with them (short and specific, warm, direct, storytelling, and so on).

Content, exclude, absolutely:
- No clinical labels or therapeutic framings. Do not use words like anxiety, depression, trauma, disorder, panic, avoidance, dysregulation, catastrophizing.
- No diagnoses of any kind, even softly worded.
- No specific dates, ages, names, or identifying details.
- No verbatim long quotes. Short phrases only, when they show the person's own language.
- No speculation beyond what the entries actually show. If the entries do not show something, do not infer it.
- No advice or judgment about the person. This profile is context for another AI, not evaluation.

Formatting rules, absolute:
- Plain prose only. No markdown, no bullets, no numbered lists, no headers, no bold, no italics.
- No em-dashes or en-dashes. Use commas, colons, periods, or new paragraphs.
- No ellipses.
- No emoji or decorative characters.
- Straight ASCII quotes only.

Return only the profile prose. No preamble, no explanation, no meta-commentary.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Admin-only. Same bulletproof pattern as magnetism-corpus-seed.
  const authToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!authToken) return json({ error: "unauthorized: missing bearer" }, 401);
  const testClient = createClient(Deno.env.get("SUPABASE_URL")!, authToken);
  const { error: testErr } = await testClient.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (testErr) return json({ error: "unauthorized: bearer is not a service role key" }, 401);

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!anthropicKey) return json({ error: "Server missing ANTHROPIC_API_KEY" }, 500);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, authToken);

  const body = await req.json().catch(() => ({}));
  const targetUserId: string | undefined = typeof body?.user_id === "string" ? body.user_id : undefined;
  const force: boolean = body?.force === true;

  // Figure out which users to process. If user_id is passed, just that one;
  // otherwise every users row (freshness check filters below).
  let userIds: string[] = [];
  if (targetUserId) {
    userIds = [targetUserId];
  } else {
    const { data: rows, error } = await admin.from("users").select("id");
    if (error) return json({ error: "user list failed", detail: error.message }, 500);
    userIds = (rows ?? []).map((r: { id: string }) => r.id);
  }

  const results: Array<{ user_id: string; status: string; entry_count?: number; profile_chars?: number }> = [];

  for (const userId of userIds) {
    const outcome = await refreshOneUser(admin, userId, force, anthropicKey);
    results.push({ user_id: userId, ...outcome });
  }

  return json({
    processed: userIds.length,
    refreshed: results.filter((r) => r.status === "refreshed").length,
    skipped: results.filter((r) => r.status !== "refreshed").length,
    results,
  }, 200);
});

async function refreshOneUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
  force: boolean,
  anthropicKey: string,
): Promise<{ status: string; entry_count?: number; profile_chars?: number; error?: string }> {
  // Freshness check. Skip if we regenerated within the interval.
  if (!force) {
    const { data: existing } = await admin
      .from("memory_profiles")
      .select("updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (existing?.updated_at) {
      const updatedAt = new Date(existing.updated_at);
      const stalenessMs = REFRESH_INTERVAL_MONTHS * 30 * 24 * 60 * 60 * 1000;
      if (Date.now() - updatedAt.getTime() < stalenessMs) {
        return { status: "skipped_fresh" };
      }
    }
  }

  // Pull the user's entries. Only unflagged entries, both roles included so
  // the model sees the shape of the conversations. Chronological.
  const { data: rows, error } = await admin
    .from("conversations")
    .select("role, content, created_at")
    .eq("user_id", userId)
    .eq("flagged_by_safety_gate", false)
    .order("created_at", { ascending: true })
    .limit(MAX_ENTRIES_TO_SUMMARIZE * 2); // *2 since each entry = user + assistant pair

  if (error) return { status: "error", error: error.message };

  const userEntries = (rows ?? []).filter((r: { role: string }) => r.role === "user");
  if (userEntries.length < MIN_ENTRIES_FOR_PROFILE) {
    return { status: "skipped_too_few", entry_count: userEntries.length };
  }

  // Build the transcript for Sonnet. Numbered entries, no dates.
  const transcript = userEntries
    .map((r: { content: string }, i: number) => `Entry ${i + 1}:\n${r.content}`)
    .join("\n\n---\n\n");

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: MEMORY_INSTRUCTION,
      messages: [{ role: "user", content: transcript }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return { status: "error", error: `Claude ${claudeRes.status}: ${errText.slice(0, 200)}` };
  }

  const claudeData = await claudeRes.json();
  const rawProfile: string = (claudeData.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n")
    .trim();

  const profile = sanitizeReply(rawProfile);

  if (!profile) {
    return { status: "error", error: "empty profile from Claude" };
  }

  // Upsert into memory_profiles. Trigger note: this table has no auto-set
  // trigger on updated_at, so we set it explicitly.
  const { error: upsertError } = await admin
    .from("memory_profiles")
    .upsert(
      { user_id: userId, summary: profile, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );

  if (upsertError) return { status: "error", error: upsertError.message };

  return { status: "refreshed", entry_count: userEntries.length, profile_chars: profile.length };
}

// Same sanitizer as magnetism-chat, duplicated here to keep this function
// self-contained. If we grow more voice-emitting functions, extract to a
// shared module.
function sanitizeReply(text: string): string {
  return text
    .replace(/[—–]/g, ",")
    .replace(/--/g, ",")
    .replace(/…/g, ".")
    .replace(/\.{3,}/g, ".")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/,\s*,/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/,([^\s])/g, ", $1")
    .trim();
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
