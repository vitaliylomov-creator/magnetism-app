// ────────────────────────────────────────────────────────────────────────────
// magnetism-chat — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Magnetism Supabase (ocsrmgneyttdkingkiev)
// Deploy:  supabase functions deploy magnetism-chat \
//            --project-ref ocsrmgneyttdkingkiev
//          (JWT verification ON — callers are signed in)
//
// Sprint 1 scope only (MAGNETISM_Technical_Brief_Claude_Code.md §10):
//   - Both OS docs (Magnetism OS, Principal OS) as a STATIC corpus pasted
//     verbatim into the system prompt. No RAG/embeddings (Sprint 3).
//   - No safety gate yet (Sprint 2). This function must not be exposed to
//     real users before that lands — Sprint 1 is founder-only testing.
//   - No memory-refresh cron (Sprint 4) — memory_profiles is read but will
//     usually be empty; that's expected, not a bug.
//
// Diary interaction model (Project Definition §4.1 / Technical Brief §8):
// the caller sends one complete entry, this function returns one whole
// reply — no streaming, no partial tokens. The frontend must not fake a
// typing indicator; the pause before the reply is intentional.
//
// Request body:
//   { "message": "<diary entry text>" }
//
// Response:
//   200 { response: string }
//   400 { error }  — missing/empty message
//   401 { error }  — missing/invalid JWT
//   500 { error }  — Anthropic / DB error
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { MAGNETISM_OS, PRINCIPAL_OS } from "../_shared/magnetism-corpus.ts";

const MODEL = "claude-sonnet-4-6";

const VOICE_PERSONA = `You are Magnetism — a private psychological voice inside the Talent Mates ecosystem, for people who carry public pressure (athletes, musicians, founders).

Register: private, warm, direct, no flattery, no empty cheerleading. You tell the truth even when it's inconvenient. You are NOT the Edge OS "race engineer" voice used elsewhere in Talent Mates (MATE/MUSE/NORTH) — that voice is public, competitive, sharp. Yours is the opposite register: the voice before and after the race, when no one else is around.

Interaction model: the person just wrote you a complete diary entry, not a chat message. Do not respond as if mid-conversation. Respond once, as a whole letter answering a letter — grounded in the wisdom corpus below, not generic advice from nowhere.

Hard scope limits, never cross these:
- You are not a therapist and not a person. Never diagnose, never use clinical labels, even softly.
- Active scope is motivation, identity, discipline, decision-making under pressure — not therapy.
- If the person signals acute crisis (self-harm, suicide, immediate danger), do not explore it in conversation. Respond warmly and immediately with a concrete redirect to real help (a crisis line, "call this person now") and stop there for this message. Silence or dodging in that moment is the one unacceptable failure of this product.
  (Note: Sprint 1 has no dedicated safety-gate classifier in front of you yet — this instruction is your only safeguard right now. Err toward redirecting whenever in doubt.)`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return json({ error: "Invalid or expired token" }, 401);
    }

    const body = await req.json().catch(() => null);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) {
      return json({ error: "message is required" }, 400);
    }

    // Service-role client for cross-table reads not covered by the caller's
    // own RLS-visible rows (users/memory_profiles are still user-scoped by
    // RLS, but using service role here keeps this function's read path
    // consistent regardless of which table gains stricter policies later).
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: profileRow } = await admin
      .from("users")
      .select("domain")
      .eq("id", user.id)
      .maybeSingle();

    const { data: memoryRow } = await admin
      .from("memory_profiles")
      .select("summary")
      .eq("user_id", user.id)
      .maybeSingle();

    const domain = profileRow?.domain ?? "none";
    const memorySummary = memoryRow?.summary?.trim();

    const domainOverlay = domainOverlayFor(domain);

    const systemPrompt = [
      VOICE_PERSONA,
      memorySummary
        ? `\nWhat you remember about this person from past entries:\n${memorySummary}`
        : `\nYou have no prior memory of this person yet — this may be their first entry.`,
      domainOverlay,
      `\n---\n# WISDOM CORPUS — MAGNETISM OS\n\n${MAGNETISM_OS}`,
      `\n---\n# WISDOM CORPUS — PRINCIPAL OS\n\n${PRINCIPAL_OS}`,
    ].join("\n");

    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    if (!ANTHROPIC_KEY) {
      return json({ error: "Server missing ANTHROPIC_API_KEY" }, 500);
    }

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error("[magnetism-chat] Anthropic error:", claudeRes.status, errText);
      return json({ error: "Failed to reach Claude" }, 500);
    }

    const claudeData = await claudeRes.json();
    const responseText = (claudeData.content ?? [])
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text: string }) => block.text)
      .join("\n")
      .trim();

    const sessionId = crypto.randomUUID();

    const { error: insertError } = await admin.from("conversations").insert([
      { user_id: user.id, session_id: sessionId, role: "user", content: message },
      { user_id: user.id, session_id: sessionId, role: "assistant", content: responseText },
    ]);

    if (insertError) {
      console.error("[magnetism-chat] insert error:", insertError);
      // Don't fail the request over a logging write — the person still gets their reply.
    }

    return json({ response: responseText }, 200);
  } catch (err) {
    console.error("[magnetism-chat] unexpected error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});

function domainOverlayFor(domain: string): string {
  switch (domain) {
    case "mate":
      return "\nThis person's context is MATE (football) — scene pressure, performance under evaluation, recovery from loss or injury.";
    case "muse":
      return "\nThis person's context is MUSE (music/creative) — public exposure of creative work, critique, release anxiety.";
    case "north":
      return "\nThis person's context is NORTH (brand/founder) — representative pressure of building and speaking for a brand.";
    default:
      return "";
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
