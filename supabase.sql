-- ============================================================
-- Gestion Engins — schéma de synchronisation Supabase
-- À exécuter une fois dans : Supabase Studio → SQL Editor → New query
-- Puis coller URL du projet + clé anon dans l'application (Paramètres).
-- ============================================================

create table if not exists public.data (
  collection text not null,
  id         text not null,
  payload    jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

create index if not exists data_updated_at_idx on public.data (updated_at);

alter table public.data enable row level security;

-- Accès avec la clé anon (application monoposte / équipe privée).
-- Pour durcir : remplacer true par une condition sur un claim JWT.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='data' and policyname='lecture anon'
  ) then
    create policy "lecture anon" on public.data for select
      to anon, authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='data' and policyname='ecriture anon'
  ) then
    create policy "ecriture anon" on public.data for insert
      to anon, authenticated with check (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='data' and policyname='maj anon'
  ) then
    create policy "maj anon" on public.data for update
      to anon, authenticated using (true) with check (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='data' and policyname='suppr anon'
  ) then
    create policy "suppr anon" on public.data for delete
      to anon, authenticated using (true);
  end if;
end $$;

-- ============================================================
-- REALTIME : nécessaire pour le WebSocket temps réel
-- Expose toutes les colonnes lors des changements (INSERT/UPDATE/DELETE)
-- et inscrit la table dans la publication Supabase Realtime.
-- ============================================================
alter table public.data replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'data'
  ) then
    alter publication supabase_realtime add table public.data;
  end if;
end $$;
