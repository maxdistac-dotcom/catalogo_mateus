create table if not exists public.cart_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  cart jsonb not null default '{}'::jsonb,
  selected_client_code text,
  updated_at timestamptz not null default now()
);

alter table public.cart_states enable row level security;

alter table public.cart_states
add column if not exists client_base jsonb;

drop policy if exists "Ler proprio carrinho" on public.cart_states;
create policy "Ler proprio carrinho"
on public.cart_states
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Criar proprio carrinho" on public.cart_states;
create policy "Criar proprio carrinho"
on public.cart_states
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Atualizar proprio carrinho" on public.cart_states;
create policy "Atualizar proprio carrinho"
on public.cart_states
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
