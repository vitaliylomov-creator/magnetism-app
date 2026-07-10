// ────────────────────────────────────────────────────────────────────────────
// magnetism-corpus-seed — one-shot RAG index builder
// ────────────────────────────────────────────────────────────────────────────
//
// Chunks both OS documents by H2 module, embeds each chunk with OpenAI
// text-embedding-3-small (1536-dim, matches wisdom_corpus.embedding), and
// upserts into wisdom_corpus. Idempotent: existing rows for the two
// documents are deleted, then fresh rows inserted from the current
// _shared/magnetism-corpus.ts content.
//
// Deploy:
//   supabase functions deploy magnetism-corpus-seed --project-ref ocsrmgneyttdkingkiev
//
// Invoke (only ops/admin, from CLI):
//   curl -X POST https://ocsrmgneyttdkingkiev.supabase.co/functions/v1/magnetism-corpus-seed \
//     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
//     -H "Content-Type: application/json"
//
// Auth: config.toml sets verify_jwt = false so the function is callable
// without a user JWT. Function itself requires the caller's bearer token to
// match SUPABASE_SERVICE_ROLE_KEY. This keeps the seed endpoint scoped to
// people who already have DB admin credentials.
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { MAGNETISM_OS, PRINCIPAL_OS } from "../_shared/magnetism-corpus.ts";
import { chunkOsDoc, WisdomChunk } from "../_shared/wisdom_chunks.ts";

const EMBED_MODEL = "text-embedding-3-small";
const DOCUMENTS = ["magnetism_os", "principal_os"] as const;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // Admin-only. Verify the caller's bearer is actually a service-role key
  // by calling an admin auth API endpoint that requires elevated privileges
  // (listUsers). Anon/user JWTs fail this call with a clear error. RLS
  // `using (false)` policies would not — they return empty silently, so
  // a select-based check misses anonymous callers.
  const authToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!authToken) {
    return json({ error: "unauthorized: missing bearer" }, 401);
  }
  const testClient = createClient(Deno.env.get("SUPABASE_URL")!, authToken);
  const { error: testErr } = await testClient.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (testErr) {
    return json({ error: "unauthorized: bearer is not a service role key" }, 401);
  }
  const serviceKey = authToken;

  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!openaiKey) {
    return json({ error: "Server missing OPENAI_API_KEY" }, 500);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  // Chunk both documents. Preserve module boundaries so semantically
  // self-contained modules stay whole.
  const chunks: WisdomChunk[] = [
    ...chunkOsDoc("magnetism_os", MAGNETISM_OS),
    ...chunkOsDoc("principal_os", PRINCIPAL_OS),
  ];

  if (chunks.length === 0) {
    return json({ error: "no chunks produced from OS docs" }, 500);
  }

  // Batch-embed. OpenAI accepts up to 2048 inputs per call; we have ~15.
  const embRes = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: chunks.map((c) => c.content),
    }),
  });

  if (!embRes.ok) {
    const detail = await embRes.text();
    console.error("[corpus-seed] OpenAI error:", embRes.status, detail);
    return json({ error: "OpenAI embed failed", detail: detail.slice(0, 300) }, 500);
  }

  const embData = await embRes.json();
  const embeddings: number[][] = (embData.data ?? []).map((d: { embedding: number[] }) => d.embedding);
  if (embeddings.length !== chunks.length) {
    return json({
      error: "embedding count mismatch",
      expected: chunks.length,
      got: embeddings.length,
    }, 500);
  }

  // Idempotent: clear existing rows for these documents, then insert fresh.
  const { error: deleteError } = await admin
    .from("wisdom_corpus")
    .delete()
    .in("document", DOCUMENTS as unknown as string[]);

  if (deleteError) {
    return json({ error: "delete failed", detail: deleteError.message }, 500);
  }

  const rows = chunks.map((c, i) => ({
    document: c.document,
    module: c.module,
    domain: c.domain,
    content: c.content,
    embedding: embeddings[i],
  }));

  const { error: insertError } = await admin.from("wisdom_corpus").insert(rows);
  if (insertError) {
    return json({ error: "insert failed", detail: insertError.message }, 500);
  }

  return json({
    ok: true,
    count: rows.length,
    chunks: chunks.map((c) => ({
      document: c.document,
      module: c.module,
      chars: c.content.length,
    })),
  }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
