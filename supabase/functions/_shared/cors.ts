// Shared CORS headers for all magnetism-* Edge Functions.
//
// Wildcard origin is acceptable here because every endpoint requires a valid
// Supabase JWT in the Authorization header — RLS enforces tenant isolation
// regardless of origin. Tighten to specific origins later if needed.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
