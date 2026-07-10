-- MAGNETISM — Sprint 1 schema
-- Full schema per MAGNETISM_Technical_Brief_Claude_Code.md §4, applied in one
-- migration. Only `users`, `memory_profiles`, `conversations` are read/written
-- by Sprint 1's magnetism-chat function — the rest are schema-ready for their
-- own sprint (wisdom_corpus/RAG: Sprint 3, memory cron: Sprint 4, safety gate:
-- Sprint 2, consultants/subscriptions: Sprint 6+).

create extension if not exists vector;

-- ─────────────────────────────────────────────
-- users — one row per auth.users, created on signup
-- ─────────────────────────────────────────────
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  linked_account_id uuid, -- optional link to MATE/MUSE/NORTH account, unenforced FK (separate Supabase projects)
  domain text not null default 'none' check (domain in ('mate', 'muse', 'north', 'none')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users enable row level security;

create policy "users select own row"
  on public.users for select
  using (auth.uid() = id);

create policy "users update own row"
  on public.users for update
  using (auth.uid() = id);

create function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- Auto-create a users row when someone signs up via Supabase Auth.
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────
-- memory_profiles — curated summary, regenerated every 6 months (Sprint 4 cron)
-- ─────────────────────────────────────────────
create table public.memory_profiles (
  user_id uuid primary key references public.users(id) on delete cascade,
  summary text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.memory_profiles enable row level security;

create policy "memory_profiles select own"
  on public.memory_profiles for select
  using (auth.uid() = user_id);

create policy "memory_profiles upsert own"
  on public.memory_profiles for insert
  with check (auth.uid() = user_id);

create policy "memory_profiles update own"
  on public.memory_profiles for update
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- conversations — raw message log, role + content per turn
-- ─────────────────────────────────────────────
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  session_id uuid not null default gen_random_uuid(),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  flagged_by_safety_gate boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.conversations enable row level security;

create policy "conversations select own"
  on public.conversations for select
  using (auth.uid() = user_id);

create policy "conversations insert own"
  on public.conversations for insert
  with check (auth.uid() = user_id);

create index conversations_user_created_idx
  on public.conversations (user_id, created_at desc);

-- ─────────────────────────────────────────────
-- wisdom_corpus — OS-document chunks with embeddings (Sprint 3 RAG)
-- ─────────────────────────────────────────────
create table public.wisdom_corpus (
  id uuid primary key default gen_random_uuid(),
  document text not null,
  module text not null,
  domain text not null default 'universal' check (domain in ('universal', 'mate', 'muse', 'north')),
  content text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

-- No RLS — this is curated system content, not user data. Read via
-- service-role only from the edge function, never exposed to client anon key.
alter table public.wisdom_corpus enable row level security;

create policy "wisdom_corpus no client access"
  on public.wisdom_corpus for select
  using (false);

-- ─────────────────────────────────────────────
-- safety_incidents — every redirect-reflex trigger, for consultant review
-- ─────────────────────────────────────────────
create table public.safety_incidents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  anonymized_context text,
  resource_shown text,
  created_at timestamptz not null default now()
);

alter table public.safety_incidents enable row level security;

create policy "safety_incidents no client access"
  on public.safety_incidents for select
  using (false);

-- ─────────────────────────────────────────────
-- consultants — live specialist directory (Sprint 6)
-- ─────────────────────────────────────────────
create table public.consultants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text not null check (domain in ('sport', 'culture', 'business')),
  bio text,
  price_cents integer,
  available boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.consultants enable row level security;

create policy "consultants public read"
  on public.consultants for select
  using (available = true);

-- ─────────────────────────────────────────────
-- consultant_bookings — booking + payment status (Sprint 6)
-- ─────────────────────────────────────────────
create table public.consultant_bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  consultant_id uuid not null references public.consultants(id),
  status text not null default 'pending' check (status in ('pending', 'paid', 'confirmed', 'cancelled')),
  scheduled_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.consultant_bookings enable row level security;

create policy "consultant_bookings select own"
  on public.consultant_bookings for select
  using (auth.uid() = user_id);

create policy "consultant_bookings insert own"
  on public.consultant_bookings for insert
  with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- subscriptions — Stripe status (Sprint 8)
-- ─────────────────────────────────────────────
create table public.subscriptions (
  user_id uuid primary key references public.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'none',
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

create policy "subscriptions select own"
  on public.subscriptions for select
  using (auth.uid() = user_id);
