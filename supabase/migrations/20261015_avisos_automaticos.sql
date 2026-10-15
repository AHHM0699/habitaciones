-- Aplicado en Supabase el 15/10/2026. Registro de referencia.
alter table public.habitaciones add column if not exists observaciones text not null default '';

alter table public.config
  add column if not exists auto_activo boolean not null default false,
  add column if not exists auto_previo integer not null default 5 check (auto_previo between 1 and 15),
  add column if not exists aviso_celular text not null default '';

create table if not exists public.avisos (
  id uuid primary key default gen_random_uuid(),
  inquilino_id uuid references public.inquilinos(id) on delete cascade,
  periodo text,
  tipo text not null check (tipo in ('previo','hoy','vencido','dueno')),
  fecha date not null,
  estado text not null check (estado in ('enviado','error','pendiente','pagado','descartado','caducado')),
  deuda numeric not null default 0,
  dias integer not null default 0,
  detalle text not null default '',
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  constraint avisos_unico_dia unique (inquilino_id, tipo, fecha)
);
create index if not exists avisos_fecha on public.avisos (fecha desc);
alter table public.avisos enable row level security;
create policy "activos gestionan avisos" on public.avisos for all to authenticated
  using ((select public.es_activo())) with check ((select public.es_activo()));
alter publication supabase_realtime add table public.avisos;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Clave con la que la tarea diaria llama a la función "avisos"
select vault.create_secret(encode(extensions.gen_random_bytes(24),'hex'),'avisos_cron')
where not exists (select 1 from vault.secrets where name='avisos_cron');

create or replace function public.avisos_clave_ok(p text)
returns boolean language sql stable security definer set search_path to ''
as $$ select exists (select 1 from vault.decrypted_secrets where name='avisos_cron' and decrypted_secret=p) $$;
revoke all on function public.avisos_clave_ok(text) from public, anon, authenticated;
grant execute on function public.avisos_clave_ok(text) to service_role;

-- Todos los días a las 9:00 a. m. de Perú (14:00 UTC)
select cron.schedule('avisos-diarios','0 14 * * *', $$
  select net.http_post(
    url := 'https://uscgdhqfpzopyzoeydjn.supabase.co/functions/v1/avisos',
    headers := jsonb_build_object('Content-Type','application/json','x-cron',
      (select decrypted_secret from vault.decrypted_secrets where name='avisos_cron')),
    body := '{"modo":"diario"}'::jsonb,
    timeout_milliseconds := 60000)
$$);
