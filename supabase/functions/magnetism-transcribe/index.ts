// ────────────────────────────────────────────────────────────────────────────
// magnetism-transcribe — voice-to-text for the composer
// ────────────────────────────────────────────────────────────────────────────
//
// Takes a short audio recording from the browser (MediaRecorder blob),
// forwards it to OpenAI Whisper, returns the transcript. The frontend
// then drops the text into the textarea for the person to review and
// send with the normal quill button. Audio is never stored, it passes
// through this function to Whisper and disappears.
//
// Deploy:
//   supabase functions deploy magnetism-transcribe --project-ref ocsrmgneyttdkingkiev
//
// Request:
//   POST /functions/v1/magnetism-transcribe
//   Authorization: Bearer <user JWT>
//   Content-Type: multipart/form-data
//   Form fields:
//     audio: File (webm/mp4/wav/etc, up to ~10 MB per Whisper's 25 MB limit)
//
// Response:
//   200 { text: string }
//   400 { error }  — missing audio
//   401 { error }  — no/invalid JWT
//   413 { error }  — audio too large
//   500 { error }  — OpenAI error
//
// Auth: default verify_jwt = true. Every caller must be a signed-in user.
// This keeps the endpoint from being a free transcription proxy for the
// internet if the URL ever leaks.
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const WHISPER_MODEL = "whisper-1";
// Whisper allows 25 MB. We cap smaller to keep edge function memory sane
// and to catch runaway recordings early. ~10 MB is roughly 30 min of
// opus-compressed voice, which is well beyond a normal diary entry.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) return json({ error: "Invalid or expired token" }, 401);

    const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
    if (!openaiKey) return json({ error: "Server missing OPENAI_API_KEY" }, 500);

    let form: FormData;
    try {
      form = await req.formData();
    } catch (_e) {
      return json({ error: "Invalid multipart body" }, 400);
    }

    const audio = form.get("audio");
    if (!(audio instanceof File)) return json({ error: "audio file required" }, 400);
    if (audio.size === 0) return json({ error: "audio is empty" }, 400);
    if (audio.size > MAX_AUDIO_BYTES) {
      return json({ error: `audio too large (${audio.size} bytes, max ${MAX_AUDIO_BYTES})` }, 413);
    }

    // Forward to Whisper. Whisper auto-detects language, so English,
    // Ukrainian, Russian, all work without a language hint from us. If
    // the person switches mid-recording, it does the right thing.
    const whisperForm = new FormData();
    whisperForm.append("file", audio, audio.name || "recording.webm");
    whisperForm.append("model", WHISPER_MODEL);
    // Response format: json (the default) gives us just { text }. We
    // don't want verbose_json / word timestamps; the person is reviewing
    // the text before submit, that's the correction pass.
    whisperForm.append("response_format", "json");
    // Prompt hint: keeps Whisper from over-punctuating short entries and
    // matches the voice-persona formatting rules the rest of the product
    // follows. Whisper honors this loosely; it is a hint, not a rule.
    whisperForm.append(
      "prompt",
      "This is a personal diary entry. Transcribe naturally in the speaker's own language. No em-dashes, no ellipses, no emoji.",
    );

    const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}` },
      body: whisperForm,
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      console.error("[magnetism-transcribe] Whisper error:", whisperRes.status, errText);
      return json({ error: "Transcription failed", detail: errText.slice(0, 300) }, 500);
    }

    const data = await whisperRes.json();
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    return json({ text }, 200);
  } catch (err) {
    console.error("[magnetism-transcribe] unexpected error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
