-- Aplicado en Supabase el 11/11/2026. Registro de referencia.
-- Firma de pagos con PIN, igual que en Separaciones:
--  * Cualquiera con acceso a la app registra un pago (indicando quién atendió). Queda "por firmar" y NO cuenta en la deuda.
--  * Abdon Huidobro o Liliana Montenegro lo firman (o rechazan con motivo) con su PIN. Si ponen su PIN al registrar, queda firmado de una vez.
--  * Eliminar un pago también pide PIN.
-- La app ya no puede insertar, cambiar ni borrar pagos directamente: solo con estas funciones, que verifican el PIN.
-- Los PIN se guardan cifrados (bcrypt) en el esquema "privado", que la API no expone. NO se escriben en este repo:
--   insert into privado.firmantes (nombre, pin_hash) values ('Nombre', extensions.crypt('PIN', extensions.gen_salt('bf')));

create schema if not exists privado;
revoke all on schema privado from public, anon, authenticated;

create table if not exists privado.firmantes (
  nombre text primary key,
  pin_hash text not null
);
-- Intentos fallidos: 5 seguidos bloquean la firma 10 minutos
create table if not exists privado.fallos (
  id int primary key default 1 check (id = 1),
  n int not null default 0,
  hasta timestamptz
);
insert into privado.fallos (id) values (1) on conflict do nothing;

-- Los pagos que ya existían quedan como firmados (sin nombre de firmante)
alter table public.pagos add column if not exists estado text not null default 'firmado';
alter table public.pagos drop constraint if exists pagos_estado_chk;
alter table public.pagos add constraint pagos_estado_chk check (estado in ('por_firmar', 'firmado', 'rechazado'));
alter table public.pagos add column if not exists atendido_por text;
alter table public.pagos add column if not exists firmado_por text;
alter table public.pagos add column if not exists firmado_en timestamptz;
alter table public.pagos add column if not exists motivo text;
create index if not exists pagos_por_firmar_idx on public.pagos (estado) where estado = 'por_firmar';

-- Solo los pagos firmados cuentan en saldos, estados y avisos (estado_inquilinos, saldos_periodos y avisos_calcular salen de aquí)
create or replace function public.periodos_al(dia date)
 returns table(inquilino_id uuid, periodo text, vence date, monto numeric, pagado numeric, saldo numeric)
 language sql stable set search_path to ''
as $function$
  with ten as (
    select i.id, i.fecha_ingreso, coalesce(i.monto, 0)::numeric as monto,
      least(31, greatest(1, coalesce(i.dia_pago, 1))) as d
    from public.inquilinos i where i.activo and i.fecha_ingreso is not null
  ), per as (
    select ten.id, ten.monto, to_char(g, 'YYYY-MM') as p,
      greatest(make_date(extract(year from g)::int, extract(month from g)::int,
        least(ten.d, extract(day from g + interval '1 month' - interval '1 day')::int)), ten.fecha_ingreso) as due
    from ten cross join lateral generate_series(date_trunc('month', ten.fecha_ingreso::timestamp),
      date_trunc('month', (dia + 62)::timestamp), interval '1 month') g
  )
  select per.id, per.p, per.due, per.monto, coalesce(pg.total, 0), greatest(0, round(per.monto - coalesce(pg.total, 0), 2))
  from per left join lateral (select sum(x.monto) as total from public.pagos x
    where x.inquilino_id = per.id and x.periodo = per.p and x.estado = 'firmado') pg on true
  where per.due <= dia + 62
$function$;

-- Devuelve el nombre de quien firma, o null y deja anotado el fallo (sin lanzar error, para no deshacer el conteo)
create or replace function privado.verificar_pin(p_pin text, out nombre text, out error text)
language plpgsql security definer set search_path to '' as $$
declare f privado.fallos;
begin
  select * into f from privado.fallos where id = 1 for update;
  if f.hasta is not null and f.hasta > now() then
    error := 'Demasiados intentos. Espera ' || ceil(extract(epoch from f.hasta - now()) / 60)::int || ' min.';
    return;
  end if;
  select x.nombre into nombre from privado.firmantes x
    where coalesce(p_pin, '') <> '' and x.pin_hash = extensions.crypt(p_pin, x.pin_hash) limit 1;
  if nombre is not null then
    update privado.fallos set n = 0, hasta = null where id = 1;
    return;
  end if;
  if f.hasta is not null and f.hasta <= now() then f.n := 0; end if;
  if f.n + 1 >= 5 then
    update privado.fallos set n = 0, hasta = now() + interval '10 minutes' where id = 1;
    error := 'PIN incorrecto. Bloqueado 10 min.';
  else
    update privado.fallos set n = f.n + 1, hasta = null where id = 1;
    error := 'PIN incorrecto';
  end if;
end $$;
revoke all on function privado.verificar_pin(text) from public, anon, authenticated;

drop function if exists public.registrar_pago(text, uuid, text, numeric, date, text, text, text);
create or replace function public.registrar_pago(p_pin text, p_inquilino uuid, p_periodo text, p_monto numeric,
  p_fecha date, p_metodo text default '', p_nota text default '', p_comprobante text default null, p_atendido text default '')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v record; t public.inquilinos; r public.pagos; firma text := null; atendido text := nullif(trim(coalesce(p_atendido, '')), '');
begin
  if not public.es_activo() then return jsonb_build_object('error', 'Tu usuario no tiene permiso. Vuelve a entrar.'); end if;
  select * into t from public.inquilinos where id = p_inquilino;
  if t.id is null then return jsonb_build_object('error', 'Inquilino no encontrado'); end if;
  if p_periodo !~ '^\d{4}-(0[1-9]|1[0-2])$' then return jsonb_build_object('error', 'Mes inválido'); end if;
  if p_monto is null or p_monto <= 0 or p_monto > 1000000 then return jsonb_build_object('error', 'Monto inválido'); end if;
  if p_fecha is null then return jsonb_build_object('error', 'Falta la fecha'); end if;
  if coalesce(p_pin, '') <> '' then
    -- Con PIN: queda firmado de una vez. Un PIN equivocado no se guarda como "por firmar" sin avisar.
    v := privado.verificar_pin(p_pin);
    if v.nombre is null then return jsonb_build_object('error', v.error); end if;
    firma := v.nombre;
  elsif atendido is null then
    return jsonb_build_object('error', 'Escribe quién atendió');
  end if;
  insert into public.pagos (inquilino_id, habitacion, periodo, monto, fecha, metodo, nota, comprobante, registrado_por,
      estado, atendido_por, firmado_por, firmado_en)
    values (t.id, t.habitacion, p_periodo, round(p_monto, 2), p_fecha, coalesce(p_metodo, ''), coalesce(p_nota, ''), p_comprobante,
      auth.uid(), case when firma is null then 'por_firmar' else 'firmado' end, left(atendido, 40), firma,
      case when firma is null then null else now() end)
    returning * into r;
  return jsonb_build_object('pago', to_jsonb(r));
end $$;

create or replace function public.firmar_pago(p_pin text, p_id uuid, p_rechazar boolean default false, p_motivo text default '')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v record; r public.pagos; motivo text := nullif(trim(coalesce(p_motivo, '')), '');
begin
  if not public.es_activo() then return jsonb_build_object('error', 'Tu usuario no tiene permiso. Vuelve a entrar.'); end if;
  select * into r from public.pagos where id = p_id;
  if r.id is null then return jsonb_build_object('error', 'Pago no encontrado'); end if;
  if r.estado <> 'por_firmar' then
    return jsonb_build_object('error', case when r.estado = 'firmado' then 'Este pago ya está firmado' else 'Este pago fue rechazado' end);
  end if;
  if p_rechazar and (motivo is null or length(motivo) < 3) then return jsonb_build_object('error', 'Escribe el motivo del rechazo'); end if;
  v := privado.verificar_pin(p_pin);
  if v.nombre is null then return jsonb_build_object('error', v.error); end if;
  update public.pagos set estado = case when p_rechazar then 'rechazado' else 'firmado' end,
      firmado_por = v.nombre, firmado_en = now(), motivo = case when p_rechazar then left(motivo, 200) else null end
    where id = p_id and estado = 'por_firmar'
    returning * into r;
  return jsonb_build_object('pago', to_jsonb(r));
end $$;

create or replace function public.eliminar_pago(p_pin text, p_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v record; r public.pagos;
begin
  if not public.es_activo() then return jsonb_build_object('error', 'Tu usuario no tiene permiso. Vuelve a entrar.'); end if;
  select * into r from public.pagos where id = p_id;
  if r.id is null then return jsonb_build_object('error', 'Pago no encontrado'); end if;
  v := privado.verificar_pin(p_pin);
  if v.nombre is null then return jsonb_build_object('error', v.error); end if;
  delete from public.pagos where id = p_id;
  return jsonb_build_object('ok', true, 'comprobante', r.comprobante, 'por', v.nombre);
end $$;

revoke all on function public.registrar_pago(text, uuid, text, numeric, date, text, text, text, text) from public, anon;
revoke all on function public.firmar_pago(text, uuid, boolean, text) from public, anon;
revoke all on function public.eliminar_pago(text, uuid) from public, anon;
grant execute on function public.registrar_pago(text, uuid, text, numeric, date, text, text, text, text) to authenticated;
grant execute on function public.firmar_pago(text, uuid, boolean, text) to authenticated;
grant execute on function public.eliminar_pago(text, uuid) to authenticated;

-- La app solo lee pagos; escribir es solo con las funciones de arriba
drop policy if exists "activos gestionan pagos" on public.pagos;
drop policy if exists "activos leen pagos" on public.pagos;
create policy "activos leen pagos" on public.pagos for select to authenticated using ((select public.es_activo()));
