-- Aplicado en Supabase el 11/11/2026. Registro de referencia.
-- Avisos automáticos al grupo de WhatsApp "HABITACIONES", publicados por el WhatsApp de Liliana (934634196)
-- desde el Samsung: es el mismo enviador del Poco de Separaciones (~/separaciones-avisos/enviar.mjs), que además
-- revisa esta cola. Igual que en Separaciones:
--  * pago registrado sin firma  → "Pago de habitación por firmar" con enlace directo para firmar
--  * pago firmado o rechazado   → "Firmado por …" / "Rechazado por … · Motivo"
-- Solo se encola si el enviador dio señal en los últimos 3 minutos; si no, la app muestra el botón para avisar a mano.
-- La clave del enviador vive en el Vault (nombre 'hab_bot_clave'), NO en este repo:
--   select vault.create_secret('CLAVE', 'hab_bot_clave');

create table if not exists public.wa_salida (
  id bigserial primary key,
  texto text not null,
  creado timestamptz not null default now(),
  enviado_en timestamptz,
  intentos int not null default 0,
  error text
);
alter table public.wa_salida enable row level security;   -- sin políticas: solo las funciones de abajo la tocan
revoke all on public.wa_salida from anon, authenticated;

create table if not exists privado.bot (
  id int primary key default 1 check (id = 1),
  visto timestamptz,
  aviso text
);
alter table privado.bot enable row level security;
insert into privado.bot (id) values (1) on conflict do nothing;

create or replace function privado.bot_clave_ok(p text) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce(p, '') <> '' and exists (select 1 from vault.decrypted_secrets where name = 'hab_bot_clave' and decrypted_secret = p)
$$;
revoke all on function privado.bot_clave_ok(text) from public, anon, authenticated;

-- El enviador pide los mensajes pendientes (y así da señal de vida)
create or replace function public.bot_pendientes(p_clave text) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  if not privado.bot_clave_ok(p_clave) then return jsonb_build_object('error', 'clave'); end if;
  update privado.bot set visto = now(), aviso = null where id = 1;
  return jsonb_build_object('grupo', 'HABITACIONES', 'mensajes', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'texto', x.texto) order by x.id)
    from (select w.id, w.texto from public.wa_salida w
          where w.enviado_en is null and w.intentos < 5 and w.creado > now() - interval '1 day'
          order by w.id limit 10) x), '[]'::jsonb));
end $$;

create or replace function public.bot_enviado(p_clave text, p_id bigint, p_ok boolean, p_error text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  if not privado.bot_clave_ok(p_clave) then return jsonb_build_object('error', 'clave'); end if;
  if p_ok then update public.wa_salida set enviado_en = now(), error = null where id = p_id;
  else update public.wa_salida set intentos = intentos + 1, error = left(coalesce(p_error, ''), 200) where id = p_id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- El número no está en el grupo: no cuenta como conectado (la app ofrece el botón)
create or replace function public.bot_sin_grupo(p_clave text) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  if not privado.bot_clave_ok(p_clave) then return jsonb_build_object('error', 'clave'); end if;
  update privado.bot set visto = null, aviso = 'El número no está en el grupo HABITACIONES' where id = 1;
  return jsonb_build_object('ok', true);
end $$;

-- Para la app: ¿el enviador está conectado?
create or replace function public.bot_estado() returns jsonb
language sql stable security definer set search_path to '' as $$
  select case when public.es_activo() then jsonb_build_object(
    'vivo', coalesce((select b.visto > now() - interval '3 minutes' from privado.bot b where b.id = 1), false),
    'aviso', (select b.aviso from privado.bot b where b.id = 1)) end
$$;

revoke all on function public.bot_pendientes(text), public.bot_enviado(text, bigint, boolean, text), public.bot_sin_grupo(text), public.bot_estado() from public;
grant execute on function public.bot_pendientes(text), public.bot_enviado(text, bigint, boolean, text), public.bot_sin_grupo(text) to anon, authenticated;
grant execute on function public.bot_estado() to authenticated;

-- Cada pago por firmar, firma y rechazo deja su mensaje en la cola
create or replace function public.tg_pago_aviso() returns trigger
language plpgsql security definer set search_path to '' as $$
declare
  t public.inquilinos; txt text; mes text; cab text;
  meses text[] := array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
begin
  if not coalesce((select b.visto > now() - interval '3 minutes' from privado.bot b where b.id = 1), false) then return null; end if;
  select * into t from public.inquilinos where id = new.inquilino_id;
  mes := meses[split_part(new.periodo, '-', 2)::int] || ' ' || split_part(new.periodo, '-', 1);
  cab := 'Hab. ' || lpad(new.habitacion::text, 2, '0') || ' · ' || coalesce(t.nombre, '');
  if tg_op = 'INSERT' and new.estado = 'por_firmar' then
    txt := '*Pago de habitación por firmar* ✍️' || E'\n' || cab || E'\n'
      || 'Monto: S/ ' || public.aviso_num(new.monto) || case when coalesce(new.metodo, '') <> '' then ' (' || new.metodo || ')' else '' end
      || ' · ' || to_char(new.fecha, 'DD/MM/YYYY') || E'\n'
      || 'Mes: ' || mes
      || case when new.atendido_por is not null then E'\nAtendió: ' || new.atendido_por else '' end
      || E'\n\nFirmar: https://ahhm0699.github.io/habitaciones/#pago=' || new.id;
  elsif tg_op = 'UPDATE' and old.estado = 'por_firmar' and new.estado in ('firmado', 'rechazado') then
    txt := case when new.estado = 'firmado' then '✅ *Firmado* por ' else '❌ *Rechazado* por ' end || coalesce(new.firmado_por, '') || E'\n'
      || cab || ' · S/ ' || public.aviso_num(new.monto) || ' · ' || mes
      || case when new.estado = 'rechazado' then E'\nMotivo: ' || coalesce(new.motivo, '') else E'\nYa cuenta en su deuda.' end;
  end if;
  if txt is not null then insert into public.wa_salida (texto) values (txt); end if;
  return null;
end $$;
revoke all on function public.tg_pago_aviso() from public, anon, authenticated;

drop trigger if exists pagos_aviso_wa on public.pagos;
create trigger pagos_aviso_wa after insert or update of estado on public.pagos
  for each row execute function public.tg_pago_aviso();
