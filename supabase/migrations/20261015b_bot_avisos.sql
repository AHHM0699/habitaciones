-- Aplicado en Supabase el 15/10/2026. Registro de referencia.
-- Los avisos de cobro se calculan en la base de datos con los pagos registrados en ese momento.
-- El bot de Claude llama a avisos_preparar() cada mañana y entrega los enlaces de WhatsApp.

alter table public.avisos add column if not exists enlace text not null default '';
alter table public.avisos add column if not exists mensaje text not null default '';

-- Igual que encodeURIComponent
create or replace function public.aviso_url(p text) returns text
language plpgsql immutable strict set search_path to '' as $$
declare b bytea := convert_to(p, 'UTF8'); r text := ''; c int;
begin
  for i in 0 .. length(b) - 1 loop
    c := get_byte(b, i);
    if c between 48 and 57 or c between 65 and 90 or c between 97 and 122 or c in (33, 39, 40, 41, 42, 45, 46, 95, 126) then
      r := r || chr(c);
    else
      r := r || '%' || upper(lpad(to_hex(c), 2, '0'));
    end if;
  end loop;
  return r;
end $$;

-- Igual que fmtN de la app (es-PE)
create or replace function public.aviso_num(n numeric) returns text
language sql immutable set search_path to '' as $$
  select case when round(coalesce(n, 0), 2) = trunc(coalesce(n, 0))
    then to_char(trunc(coalesce(n, 0)), 'FM999,999,999,990')
    else to_char(round(n, 2), 'FM999,999,999,990.00') end
$$;

-- Igual que fillTpl de la app
create or replace function public.aviso_texto(tpl text, v jsonb) returns text
language plpgsql immutable set search_path to '' as $$
declare k text; r text := coalesce(tpl, '');
begin
  for k in select jsonb_object_keys(v) loop
    r := replace(r, '{' || k || '}', coalesce(v ->> k, ''));
  end loop;
  return r;
end $$;

-- Mismo cálculo que statusOf de la app: qué avisos tocan hoy y con qué mensaje
create or replace function public.avisos_calcular(hoy date)
returns table (inquilino_id uuid, tipo text, periodo text, vence date, deuda numeric, dias int, mensaje text, enlace text)
language sql stable security definer set search_path to '' as $$
with cfg as (
  select least(15, greatest(1, coalesce(c.auto_previo, 5))) as previo,
    coalesce(nullif(c.t_recordatorio, ''), 'Hola {nombre}, te recuerdo que el alquiler de la habitación {habitacion} de {mes} (S/ {monto}) vence el {fecha}. Puedes pagar por Yape al {yape} (a nombre de Liliana Montenegro Fiestas). ¡Gracias!') as t_rec,
    coalesce(nullif(c.t_vencido, ''), 'Hola {nombre}, el alquiler de la habitación {habitacion} venció el {fecha} y lleva {dias} días de atraso. El monto pendiente es S/ {deuda}. Por favor regulariza tu pago lo antes posible. Yape: {yape} (a nombre de Liliana Montenegro Fiestas). Gracias.') as t_ven,
    coalesce(c.yape, '') as yape, coalesce(c.nombre, '') as inmueble
  from public.config c where c.id = 1
),
ten as (
  select i.id, i.nombre, i.habitacion, i.fecha_ingreso, coalesce(i.monto, 0)::numeric as monto,
    least(31, greatest(1, coalesce(i.dia_pago, 1))) as dia,
    regexp_replace(coalesce(i.celular, ''), '\D', '', 'g') as cel
  from public.inquilinos i where i.activo and i.fecha_ingreso is not null
),
per as (
  select ten.id, to_char(g, 'YYYY-MM') as p,
    greatest(make_date(extract(year from g)::int, extract(month from g)::int,
      least(ten.dia, extract(day from g + interval '1 month' - interval '1 day')::int)), ten.fecha_ingreso) as due,
    ten.monto
  from ten cross join lateral generate_series(date_trunc('month', ten.fecha_ingreso::timestamp),
    date_trunc('month', (hoy + 62)::timestamp), interval '1 month') g
),
sal as (
  select per.id, per.p, per.due,
    greatest(0, round(per.monto - coalesce((select sum(pg.monto) from public.pagos pg
      where pg.inquilino_id = per.id and pg.periodo = per.p), 0), 2)) as saldo
  from per where per.due <= hoy + 62
),
est as (
  select ten.*,
    case when length(ten.cel) = 9 then '51' || ten.cel when length(ten.cel) >= 10 then ten.cel else '' end as tel,
    (select min(s.due) from sal s where s.id = ten.id and s.due < hoy and s.saldo > 0) as v_due,
    (select coalesce(sum(s.saldo), 0) from sal s where s.id = ten.id and s.due < hoy and s.saldo > 0) as v_sum,
    (select s.saldo from sal s where s.id = ten.id and s.due = hoy and s.saldo > 0) as h_saldo
  from ten
),
items as (
  -- N días antes
  select e.*, 'previo' as tipo, s.p as periodo, s.due as vence, s.saldo as monto_aviso, 0 as dias
  from est e join sal s on s.id = e.id and s.due - hoy = (select previo from cfg) and s.saldo > 0
  union all
  -- Día de vencimiento
  select e.*, 'hoy', s.p, s.due, s.saldo, 0
  from est e join sal s on s.id = e.id and s.due = hoy and s.saldo > 0
  union all
  -- Atrasado (desde el mes impago más antiguo)
  select e.*, 'vencido', s.p, s.due, e.v_sum + coalesce(e.h_saldo, 0), hoy - e.v_due
  from est e join sal s on s.id = e.id and s.due = e.v_due
),
msg as (
  select it.*, public.aviso_texto(case when it.tipo = 'vencido' then cfg.t_ven else cfg.t_rec end, jsonb_build_object(
    'nombre', coalesce((regexp_split_to_array(btrim(coalesce(it.nombre, '')), '\s+'))[1], ''),
    'habitacion', case when coalesce(it.habitacion, 0) = 0 then '—' when it.habitacion < 10 then '0' || it.habitacion else it.habitacion::text end,
    'monto', public.aviso_num(it.monto),
    'deuda', public.aviso_num(it.v_sum + coalesce(it.h_saldo, 0)),
    'dias', (case when it.v_due is null then 0 else hoy - it.v_due end)::text,
    'fecha', to_char(it.vence, 'DD/MM/YYYY'),
    'mes', (array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])[substr(it.periodo, 6, 2)::int] || ' ' || substr(it.periodo, 1, 4),
    'yape', cfg.yape, 'inmueble', cfg.inmueble, 'pago', '')) as texto
  from items it cross join cfg
)
select m.id, m.tipo, m.periodo, m.vence, m.monto_aviso, m.dias, m.texto,
  case when m.tel = '' then '' else 'https://wa.me/' || m.tel || '?text=' || public.aviso_url(m.texto) end
from msg m
$$;

-- Verifica en vivo y deja listos los avisos de hoy. Devuelve la lista para el bot.
-- Un solo atrasado: su enlace queda listo. Dos o más: quedan "pendientes" hasta confirmar uno por uno.
create or replace function public.avisos_preparar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  hoy date := (now() at time zone 'America/Lima')::date;
  activo boolean;
  n_venc int;
begin
  select c.auto_activo into activo from public.config c where c.id = 1;
  if not coalesce(activo, false) then
    return jsonb_build_object('fecha', hoy, 'activo', false, 'avisos', '[]'::jsonb);
  end if;

  -- Las preguntas de días anteriores que nadie respondió ya no aplican
  update public.avisos set estado = 'caducado', actualizado = now() where estado = 'pendiente' and fecha < hoy;

  select count(*) into n_venc from public.avisos_calcular(hoy) c where c.tipo = 'vencido';

  insert into public.avisos (inquilino_id, tipo, fecha, periodo, deuda, dias, mensaje, enlace, estado, detalle)
  select c.inquilino_id, c.tipo, hoy, c.periodo, c.deuda, c.dias, c.mensaje, c.enlace,
    case when c.enlace = '' then 'error' when c.tipo = 'vencido' and n_venc > 1 then 'pendiente' else 'enviado' end,
    case when c.enlace = '' then 'Sin celular válido' else '' end
  from public.avisos_calcular(hoy) c
  on conflict (inquilino_id, tipo, fecha) do update set periodo = excluded.periodo, deuda = excluded.deuda,
    dias = excluded.dias, mensaje = excluded.mensaje, enlace = excluded.enlace, actualizado = now();

  -- Si ya se registró el pago, ese aviso ya no hace falta
  update public.avisos a set estado = 'pagado', detalle = 'Pago registrado en la app', actualizado = now()
  where a.fecha = hoy and a.estado in ('pendiente', 'enviado', 'error') and a.inquilino_id is not null
    and not exists (select 1 from public.avisos_calcular(hoy) c where c.inquilino_id = a.inquilino_id and c.tipo = a.tipo);

  return jsonb_build_object('fecha', hoy, 'activo', true, 'avisos', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'tipo', a.tipo, 'estado', a.estado, 'inquilino', i.nombre,
      'habitacion', case when i.habitacion < 10 then '0' || i.habitacion else i.habitacion::text end,
      'deuda', a.deuda, 'dias', a.dias, 'periodo', a.periodo, 'detalle', a.detalle,
      'mensaje', a.mensaje, 'enlace', a.enlace)
      order by case a.tipo when 'vencido' then 0 when 'hoy' then 1 else 2 end, i.habitacion)
    from public.avisos a join public.inquilinos i on i.id = a.inquilino_id
    where a.fecha = hoy and a.estado in ('pendiente', 'enviado', 'error')), '[]'::jsonb));
end $$;

-- Respuesta de quien administra sobre un atrasado: 'pagado', 'omitir' o 'enviar'.
-- 'enviar' vuelve a verificar en la base de datos antes de devolver el enlace.
create or replace function public.aviso_responder(p_id uuid, p_accion text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare a public.avisos;
begin
  select * into a from public.avisos where id = p_id;
  if a.id is null then return jsonb_build_object('error', 'no_encontrado'); end if;
  if a.fecha <> (now() at time zone 'America/Lima')::date then return jsonb_build_object('estado', 'caducado'); end if;
  if p_accion = 'pagado' then
    update public.avisos set estado = 'pagado', detalle = 'Confirmado: ya pagó', actualizado = now() where id = p_id;
    return jsonb_build_object('estado', 'pagado');
  elsif p_accion = 'omitir' then
    update public.avisos set estado = 'descartado', actualizado = now() where id = p_id;
    return jsonb_build_object('estado', 'descartado');
  elsif p_accion = 'enviar' then
    perform public.avisos_preparar();
    select * into a from public.avisos where id = p_id;
    if a.estado = 'pagado' then return jsonb_build_object('estado', 'pagado', 'detalle', a.detalle); end if;
    if a.enlace = '' then return jsonb_build_object('estado', 'error', 'detalle', 'Sin celular válido'); end if;
    update public.avisos set estado = 'enviado', actualizado = now() where id = p_id;
    return jsonb_build_object('estado', 'enviado', 'deuda', a.deuda, 'dias', a.dias, 'mensaje', a.mensaje, 'enlace', a.enlace);
  end if;
  return jsonb_build_object('error', 'accion');
end $$;

revoke all on function public.aviso_url(text), public.aviso_num(numeric), public.aviso_texto(text, jsonb),
  public.avisos_calcular(date), public.avisos_preparar(), public.aviso_responder(uuid, text)
  from public, anon, authenticated;

-- Respaldo: prepara los avisos a las 8:40 a. m. de Perú aunque el bot no corra (la app los muestra)
select cron.schedule('avisos-diarios', '40 13 * * *', $$ select public.avisos_preparar() $$);
