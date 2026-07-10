// ────────────────────────────────────────────────────────────────────────────
// magnetism-chat — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Magnetism Supabase (ocsrmgneyttdkingkiev)
// Deploy:  supabase functions deploy magnetism-chat \
//            --project-ref ocsrmgneyttdkingkiev
//          (JWT verification ON — callers are signed in)
//
// Flow (MAGNETISM_Technical_Brief_Claude_Code.md §6):
//   1. Auth (JWT)
//   2. Fetch user profile + memory summary
//   3. SAFETY GATE (Sprint 2): Haiku classifier decides crisis vs safe.
//      If crisis: log to safety_incidents + conversations (flagged=true),
//      return warm redirect template in the writer's language, STOP.
//      This gate is not optional and not a feature flag. Per Project
//      Definition §7 and Technical Brief §7, silence or avoidance in an
//      acute-crisis moment is the one hard failure mode of this product.
//   4. RAG (Sprint 3): embed the entry with OpenAI text-embedding-3-small,
//      pull top-K wisdom_corpus rows via match_wisdom_corpus RPC, inject
//      only those chunks into the system prompt. On embedding failure,
//      fall back to pasting both OS docs in full (Sprint 1 style).
//   5. If safe: parallel Sonnet (main reply) + Haiku (essence line)
//   6. Insert into conversations (flagged=false), return
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
//   200 { response: string, essence: string, flagged: boolean }
//   400 { error }  — missing/empty message
//   401 { error }  — missing/invalid JWT
//   500 { error }  — Anthropic / DB error
//
// Sprint 2 hardening notes for later (Technical Brief §7):
//   - Live consultants run edge-case validation before public launch. Any
//     false positive on ordinary stress content, or false negative on
//     borderline crisis phrasing, blocks launch until tuned.
//   - Classifier failure currently fails-open to the normal flow with an
//     incident row noting "classifier_error". For real launch this should
//     be revisited: possibly fail-closed with a soft "try again" error, so
//     an intermittent Haiku hiccup can never let a real crisis through.
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { MAGNETISM_OS, PRINCIPAL_OS } from "../_shared/magnetism-corpus.ts";

const MODEL = "claude-sonnet-4-6";
const ESSENCE_MODEL = "claude-haiku-4-5-20251001";
const SAFETY_MODEL = "claude-haiku-4-5-20251001";
const EMBED_MODEL = "text-embedding-3-small";
const RAG_MATCH_COUNT = 4;

const ESSENCE_INSTRUCTION = `You will receive a diary entry. Distill it into exactly one line that could serve as the title of that diary page.

Rules, strict:
- One sentence, present tense, in the same language the entry was written in.
- Written in the writer's voice, not about the writer. Use "I" or an implicit first-person, never "the writer" or "they".
- Under 12 words.
- No em-dashes, no en-dashes, no ellipses, no markdown, no emoji, no quotation marks around the whole line.
- No period at the end.
- Concrete. Name the actual thing, not the abstract feeling. "I keep discounting before anyone asks" is right. "Struggling with self-worth" is wrong.

Return only the line, nothing else. No preamble, no explanation.`;

const SAFETY_INSTRUCTION = `You are a safety classifier. Your ONLY job is to detect signals of ACUTE, IMMEDIATE crisis in a diary entry.

Return ONLY a JSON object matching this exact shape, with no preamble and no explanation:
{"crisis": true, "language": "en"} or {"crisis": false, "language": "uk"} and so on.

crisis = true ONLY when the entry contains at least one of these signals literally in the text:
- Explicit suicidal ideation or intent: "I want to die", "I don't want to be here anymore", "I want to end it", "I want to stop existing"
- Explicit self-harm intent, present or future tense, not past
- Statements of imminent action to end life or cause serious harm: "tonight", "right now", "before morning", "I have the pills"
- Explicit requests for methods
- Explicit threat to seriously harm another person

crisis = false for all of these, no matter how heavy the tone:
- Sadness, grief, depression as a mood word without ideation
- Failure, imposter feelings, professional burnout, career defeat
- Anxiety about the future, decisions, money, relationships
- Anger or rage at self or others without stated intent to act
- Figurative language: "this is killing me", "I want to disappear", "I feel dead inside", "I can't do this anymore", "I want out", when the object is a job, business, relationship, project, or role rather than life itself
- Past hard periods described without current intent
- Statements about ending a project, business, relationship, contract, or role
- Descriptions of exhaustion, hopelessness about a situation, or being stuck

Err strongly toward crisis = false when the signal is figurative or ambiguous. False positives on ordinary stress make the diary unusable and betray the writer's trust. Trigger only on literal, explicit signals in the text.

language = the primary language of the entry.
- "uk" for Ukrainian
- "en" for English
- "other" for any other language

Return only the JSON object. No other text.`;

// Redirect templates. Warm, direct, non-avoidant, concrete resources. Per
// Project Definition §7: at first signs of acute crisis, an immediate, warm,
// concrete redirect to real help. Silence or dodging in that moment is the
// worst possible product outcome, so this template is not decorative — it is
// the entire product surface in that one moment.
const REDIRECT_TEMPLATES: Record<string, string> = {
  en: `What you're carrying here needs a real person, right now. Not me, and not later.

Please contact one of these before you close this page:

Ukraine: 7333 (Lifeline Ukraine)
United States: 988 (call or text)
United Kingdom: 116 123 (Samaritans)
International directory: findahelpline.com
Immediate emergency: 112 in Europe, 911 in the United States

Make that call first. I'll still be here after.`,

  uk: `Те, що ти зараз пишеш, потребує справжньої людини поруч, прямо зараз. Не мене, і не потім.

Будь ласка, зателефонуй до того, як закриєш цю сторінку:

Україна: 7333 (Lifeline Ukraine)
Міжнародний довідник: findahelpline.com
Термінова допомога: 112

Зроби цей дзвінок першим. Я буду тут, коли повернешся.`,
};

const VOICE_PERSONA = `You are Magnetism, a private psychological voice inside the Talent Mates ecosystem, for people who carry public pressure (athletes, musicians, founders).

Register: private, warm, direct, no flattery, no empty cheerleading. You tell the truth even when it is inconvenient. You are NOT the Edge OS "race engineer" voice used elsewhere in Talent Mates (MATE, MUSE, NORTH), which is public, competitive, sharp. Yours is the opposite register: the voice before and after the race, when no one else is around.

Interaction model: the person just wrote you a complete diary entry, not a chat message. Do not respond as if mid-conversation. Respond once, as a whole letter answering a letter, grounded in the wisdom corpus below, not generic advice from nowhere.

Output formatting rules, strict:
- Write in plain prose paragraphs only. No markdown headers, no bold, no italics, no bullet points, no numbered lists, no asterisks around words.
- Never use em-dashes or en-dashes. Use commas, colons, periods, or a new paragraph instead. This rule is absolute, do not use em-dashes even as a rhetorical device.
- Never use ellipses. If you mean pause, say pause.
- Never use emoji or decorative characters.
- Use straight ASCII quotes ("like this"), not curly quotes.
- Reply in the same language the person wrote in.

Hard scope limits, never cross these:
- You are not a therapist and not a person. Never diagnose, never use clinical labels, even softly.
- Active scope is motivation, identity, discipline, decision-making under pressure, not therapy.
- A separate safety classifier runs before you and intercepts acute-crisis entries with a warm redirect. You will only see entries that classifier judged safe. Still, if any signal of acute crisis reaches you (self-harm, suicide, immediate danger), do not explore it in conversation. Respond warmly and immediately with a concrete redirect to real help and stop there. Err toward redirecting if in doubt.`;

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

    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    if (!ANTHROPIC_KEY) {
      return json({ error: "Server missing ANTHROPIC_API_KEY" }, 500);
    }

    // ─── SAFETY GATE (Sprint 2) ─────────────────────────────────────────
    // Runs before any user-facing generation. If the classifier flags this
    // entry as acute crisis, we return the redirect template immediately
    // and never call the main Sonnet reply. On classifier error, we log
    // and fall through to the normal flow with a "classifier_error" note,
    // but this fail-open behavior is only acceptable during founder-only
    // testing (see header comment for launch hardening note).
    const gate = await classifyMessage(message, ANTHROPIC_KEY);

    if (gate.crisis) {
      const language = gate.language === "uk" ? "uk" : "en";
      const template = REDIRECT_TEMPLATES[language];
      const sessionId = crypto.randomUUID();

      // Store the actual message excerpt on the safety_incident so live
      // consultants (Sprint 7) can audit whether the classifier fired
      // correctly. Full raw message rather than truncated — the table has
      // RLS blocking client reads, so only service-role admin sees it.
      await admin.from("safety_incidents").insert({
        user_id: user.id,
        anonymized_context: message,
        resource_shown: `redirect_${language}_v1`,
      });

      await admin.from("conversations").insert([
        {
          user_id: user.id,
          session_id: sessionId,
          role: "user",
          content: message,
          flagged_by_safety_gate: true,
        },
        {
          user_id: user.id,
          session_id: sessionId,
          role: "assistant",
          content: template,
          flagged_by_safety_gate: true,
        },
      ]);

      return json({ response: template, essence: "", flagged: true }, 200);
    }

    if (gate.error) {
      // Fail-open path. Log an incident row so ops can measure how often
      // the classifier fails; do not tell the user, since we are proceeding
      // to a normal reply. Message excerpt is truncated here because this
      // is not a real crisis event, it is a classifier-flake audit trail.
      await admin.from("safety_incidents").insert({
        user_id: user.id,
        anonymized_context: message.slice(0, 200),
        resource_shown: "classifier_error",
      });
      console.warn("[magnetism-chat] classifier error, falling open:", gate.error);
    }

    // ─── SAFE PATH: normal reply + essence ──────────────────────────────

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

    // Sprint 3 RAG: embed the entry, pull top-K wisdom_corpus chunks by
    // cosine similarity, inject only those chunks into the system prompt.
    // If the OpenAI embedding call fails or returns no matches, fall back
    // to pasting both OS docs in full (Sprint 1 behavior). Fail-open here
    // is acceptable because a broader-context reply is still coherent,
    // just more expensive. Fail-closed for the safety gate is different:
    // there, silence is the failure mode.
    const corpusBlock = await buildCorpusBlock(message, admin);

    const systemPrompt = [
      VOICE_PERSONA,
      memorySummary
        ? `\nWhat you remember about this person from past entries:\n${memorySummary}`
        : `\nYou have no prior memory of this person yet. This may be their first entry.`,
      domainOverlay,
      `\n---\n${corpusBlock}`,
    ].join("\n");

    // Fire both Claude calls in parallel: Sonnet for the main reply, Haiku
    // for the essence line that titles this entry in the left spine. Running
    // in parallel means the total latency is just the slower of the two
    // (Sonnet), not the sum. Failure of the essence call is tolerable, we
    // still return the reply; failure of the reply call fails the request.
    const [claudeRes, essenceRes] = await Promise.all([
      fetch("https://api.anthropic.com/v1/messages", {
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
      }),
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ESSENCE_MODEL,
          max_tokens: 60,
          system: ESSENCE_INSTRUCTION,
          messages: [{ role: "user", content: message }],
        }),
      }),
    ]);

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error("[magnetism-chat] Anthropic error:", claudeRes.status, errText);
      return json({ error: "Failed to reach Claude" }, 500);
    }

    const claudeData = await claudeRes.json();
    const rawResponse = (claudeData.content ?? [])
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text: string }) => block.text)
      .join("\n")
      .trim();

    // Belt-and-suspenders sanitization. The system prompt already forbids
    // em-dashes, ellipses, markdown, and emoji, but the model has centuries
    // of prose training that leaks the occasional em-dash. Strip them here
    // so the person never sees one, regardless of what the model returned.
    const responseText = sanitizeReply(rawResponse);

    // Essence is best-effort. If Haiku failed or returned junk, the entry
    // still saves without one and the spine will fall back to date-only.
    let essence = "";
    if (essenceRes.ok) {
      const essenceData = await essenceRes.json();
      const rawEssence = (essenceData.content ?? [])
        .filter((block: { type: string }) => block.type === "text")
        .map((block: { text: string }) => block.text)
        .join(" ")
        .trim();
      essence = sanitizeEssence(rawEssence);
    } else {
      console.warn("[magnetism-chat] essence call failed:", essenceRes.status);
    }

    const sessionId = crypto.randomUUID();

    const { error: insertError } = await admin.from("conversations").insert([
      {
        user_id: user.id,
        session_id: sessionId,
        role: "user",
        content: message,
        essence: essence || null,
        flagged_by_safety_gate: false,
      },
      {
        user_id: user.id,
        session_id: sessionId,
        role: "assistant",
        content: responseText,
        flagged_by_safety_gate: false,
      },
    ]);

    if (insertError) {
      console.error("[magnetism-chat] insert error:", insertError);
      // Don't fail the request over a logging write, the person still gets their reply.
    }

    return json({ response: responseText, essence, flagged: false }, 200);
  } catch (err) {
    console.error("[magnetism-chat] unexpected error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});

// ─── RAG: RELEVANT-EXCERPTS CORPUS BLOCK ──────────────────────────────
// Embeds the user's entry, pulls top-K wisdom_corpus rows by cosine
// distance, returns a formatted corpus block for the system prompt.
// On any failure, falls back to pasting the full corpus (Sprint 1 style)
// so the reply always has grounding, just with more tokens.
async function buildCorpusBlock(
  message: string,
  admin: ReturnType<typeof createClient>,
): Promise<string> {
  const fullCorpus =
    `# WISDOM CORPUS: MAGNETISM OS\n\n${MAGNETISM_OS}\n\n---\n\n# WISDOM CORPUS: PRINCIPAL OS\n\n${PRINCIPAL_OS}`;

  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!openaiKey) {
    console.warn("[magnetism-chat] OPENAI_API_KEY not set, falling back to full corpus");
    return fullCorpus;
  }

  try {
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: message }),
    });

    if (!embRes.ok) {
      const errText = await embRes.text();
      console.warn("[magnetism-chat] embed failed:", embRes.status, errText.slice(0, 120));
      return fullCorpus;
    }

    const embData = await embRes.json();
    const queryEmbedding: number[] | undefined = embData?.data?.[0]?.embedding;
    if (!queryEmbedding) {
      console.warn("[magnetism-chat] no embedding in response");
      return fullCorpus;
    }

    const { data: matches, error } = await admin.rpc("match_wisdom_corpus", {
      query_embedding: queryEmbedding,
      match_count: RAG_MATCH_COUNT,
    });

    if (error) {
      console.warn("[magnetism-chat] rpc error:", error.message);
      return fullCorpus;
    }

    if (!matches || matches.length === 0) {
      console.warn("[magnetism-chat] no matches, wisdom_corpus may be empty");
      return fullCorpus;
    }

    const chunkBlocks = matches.map((m: { document: string; module: string; content: string }) => {
      const docLabel = m.document.replace("_", " ").toUpperCase();
      return `## From ${docLabel}: ${m.module}\n\n${m.content}`;
    }).join("\n\n---\n\n");

    return `# WISDOM CORPUS (relevant excerpts for this entry)\n\n${chunkBlocks}`;
  } catch (err) {
    console.warn("[magnetism-chat] RAG unexpected error:", (err as Error).message);
    return fullCorpus;
  }
}

// ─── SAFETY CLASSIFIER ────────────────────────────────────────────────
// Returns { crisis, language, error }.
// crisis / language are always defined so callers can branch simply.
// error is set when the classifier call itself failed or returned garbage;
// callers can log it and choose fail-open or fail-closed behavior.
async function classifyMessage(
  message: string,
  key: string,
): Promise<{ crisis: boolean; language: string; error: string | null }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SAFETY_MODEL,
        max_tokens: 60,
        system: SAFETY_INSTRUCTION,
        messages: [{ role: "user", content: message }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { crisis: false, language: "other", error: `http ${res.status}: ${errText.slice(0, 200)}` };
    }

    const data = await res.json();
    const raw = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join(" ")
      .trim();

    // Extract JSON. Haiku sometimes wraps output in text or code fences even
    // when instructed not to, so we pluck the first {...} block rather than
    // parsing the whole string.
    const match = raw.match(/\{[^{}]*\}/);
    if (!match) {
      return { crisis: false, language: "other", error: `no json in response: ${raw.slice(0, 120)}` };
    }

    const parsed = JSON.parse(match[0]);
    const crisis = parsed.crisis === true;
    const language = typeof parsed.language === "string" ? parsed.language : "other";
    return { crisis, language, error: null };
  } catch (err) {
    return { crisis: false, language: "other", error: (err as Error).message };
  }
}

function sanitizeEssence(text: string): string {
  return sanitizeReply(text)
    // Essence is one line, collapse any newlines Haiku sneaks in.
    .replace(/\s*\n+\s*/g, " ")
    // Strip any surrounding quotes the model might add despite the instruction.
    .replace(/^["'`]+|["'`]+$/g, "")
    // Drop trailing punctuation. Essence is a title, not a sentence.
    .replace(/[.,;:!?]+$/, "")
    // Guardrail on length: 12 words max per instruction; hard-truncate if
    // Haiku over-runs. Word count is a rough proxy but adequate for a title.
    .split(/\s+/)
    .slice(0, 14)
    .join(" ")
    .trim();
}

function sanitizeReply(text: string): string {
  return text
    // Em-dash and en-dash: replace with a comma. Comma is safest general
    // substitute, gives a slight pause without hijacking sentence structure.
    // If the dash was actually acting as a period, the sentence still reads.
    .replace(/[—–]/g, ",")
    // Double-hyphen "--" is another common em-dash proxy.
    .replace(/--/g, ",")
    // Ellipsis, both single-char and three-dot forms.
    .replace(/…/g, ".")
    .replace(/\.{3,}/g, ".")
    // Curly quotes to straight quotes.
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    // Markdown bold/italic markers. We match matched pairs only, to avoid
    // eating stray asterisks that might legitimately appear in prose.
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    // Emoji and pictographs. Covers the common Unicode ranges without
    // touching letters or CJK.
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}]/gu, "")
    // Fix up double-comma / space-comma artifacts from the dash replacement.
    .replace(/,\s*,/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/,([^\s])/g, ", $1")
    .trim();
}

function domainOverlayFor(domain: string): string {
  switch (domain) {
    case "mate":
      return "\nThis person's context is MATE (football): scene pressure, performance under evaluation, recovery from loss or injury.";
    case "muse":
      return "\nThis person's context is MUSE (music, creative): public exposure of creative work, critique, release anxiety.";
    case "north":
      return "\nThis person's context is NORTH (brand, founder): representative pressure of building and speaking for a brand.";
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
