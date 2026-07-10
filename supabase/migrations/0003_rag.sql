-- Sprint 3: RAG over the wisdom corpus.
-- Adds a similarity-search RPC that returns top-K wisdom_corpus rows by
-- cosine distance to a query embedding. Called from magnetism-chat to
-- inject only the most-relevant curated chunks into the system prompt,
-- replacing the Sprint-1 approach of pasting both OS docs verbatim.
--
-- No ANN index yet (IVFFlat/HNSW). With ~15 chunks in the corpus a
-- sequential scan is faster than either index method's overhead. Add
-- an index when the corpus reaches ~100+ chunks per Technical Brief
-- §5's roadmap (resilience, creative anxiety, founder burnout, etc.).

create or replace function public.match_wisdom_corpus(
  query_embedding vector(1536),
  match_count int default 4
)
returns table (
  id uuid,
  document text,
  module text,
  domain text,
  content text,
  distance float
)
language sql stable
as $$
  select id, document, module, domain, content,
         (embedding <=> query_embedding)::float as distance
  from public.wisdom_corpus
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_wisdom_corpus(vector, int) to authenticated, service_role;
