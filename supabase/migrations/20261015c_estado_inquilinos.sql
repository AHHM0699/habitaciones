-- Aplicado en Supabase el 15/10/2026. Registro de referencia.
-- El estado de cada inquilino (vencido, vence hoy, por vencer, al día) lo calcula Supabase.
-- La app y el bot de avisos leen las vistas estado_inquilinos y saldos_periodos.

-- Saldo de cada mes de cada inquilino activo, a una fecha (hasta 62 días adelante)
create or replace function public.periodos_al(dia date)
returns table (inquilino_id uuid, periodo text, vence date, monto numeric, pagado numeric, saldo numeric)
language sql stable set search_path to '' as $$
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
    where x.inquilino_id = per.id and x.periodo = per.p) pg on true
  where per.due <= dia + 62
$$;

-- Estado de cada inquilino activo, a una fecha
create or replace function public.estados_al(dia date)
returns table (inquilino_id uuid, estado text, deuda numeric, dias int,
  ref_periodo text, ref_vence date, ref_saldo numeric,
  prox_periodo text, prox_vence date, prox_saldo numeric, hoy date)
language sql stable set search_path to '' as $$
  with p as (select * from public.periodos_al(dia)),
  e as (
    select i.id,
      (select min(p.vence) from p where p.inquilino_id = i.id and p.vence < dia and p.saldo > 0) as v_vence,
      (select coalesce(sum(p.saldo), 0) from p where p.inquilino_id = i.id and p.vence < dia and p.saldo > 0) as v_suma,
      (select p.saldo from p where p.inquilino_id = i.id and p.vence = dia and p.saldo > 0) as h_saldo,
      (select min(p.vence) from p where p.inquilino_id = i.id and p.vence > dia and p.saldo > 0) as x_vence
    from public.inquilinos i where i.activo and i.fecha_ingreso is not null
  )
  select e.id,
    case when e.v_vence is not null then 'vencido'
      when e.h_saldo is not null then 'hoy'
      when e.x_vence - dia <= coalesce((select c.dias_aviso from public.config c where c.id = 1), 0) then 'porVencer'
      else 'alDia' end,
    round(e.v_suma + coalesce(e.h_saldo, 0), 2),
    coalesce(dia - e.v_vence, 0),
    r.periodo, r.vence, r.saldo, x.periodo, x.vence, x.saldo, dia
  from e
  left join p r on r.inquilino_id = e.id and r.vence = coalesce(e.v_vence, case when e.h_saldo is not null then dia end, e.x_vence)
  left join p x on x.inquilino_id = e.id and x.vence = e.x_vence
$$;

-- Lo que ve la app y el bot: el estado de hoy (hora de Perú)
create or replace view public.estado_inquilinos with (security_invoker = true) as
  select * from public.estados_al((now() at time zone 'America/Lima')::date);
create or replace view public.saldos_periodos with (security_invoker = true) as
  select * from public.periodos_al((now() at time zone 'America/Lima')::date);

revoke all on function public.periodos_al(date), public.estados_al(date) from public, anon;
grant execute on function public.periodos_al(date), public.estados_al(date) to authenticated, service_role;
revoke all on public.estado_inquilinos, public.saldos_periodos from anon;
grant select on public.estado_inquilinos, public.saldos_periodos to authenticated, service_role;

-- Los avisos del bot salen del mismo estado
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
est as (
  select e.inquilino_id as tid, e.estado, e.deuda as e_deuda, e.dias as e_dias, e.ref_periodo, e.ref_vence,
    i.nombre, i.habitacion, coalesce(i.monto, 0)::numeric as monto_mes,
    regexp_replace(coalesce(i.celular, ''), '\D', '', 'g') as cel
  from public.estados_al(hoy) e join public.inquilinos i on i.id = e.inquilino_id
),
per as (select * from public.periodos_al(hoy)),
items as (
  -- N días antes
  select est.*, 'previo' as i_tipo, p.periodo as i_periodo, p.vence as i_vence, p.saldo as i_deuda, 0 as i_dias
  from est join per p on p.inquilino_id = est.tid and p.vence - hoy = (select previo from cfg) and p.saldo > 0
  union all
  -- Día de vencimiento
  select est.*, 'hoy', p.periodo, p.vence, p.saldo, 0
  from est join per p on p.inquilino_id = est.tid and p.vence = hoy and p.saldo > 0
  union all
  -- Atrasado (desde el mes impago más antiguo)
  select est.*, 'vencido', est.ref_periodo, est.ref_vence, est.e_deuda, est.e_dias
  from est where est.estado = 'vencido'
),
msg as (
  select it.*,
    public.aviso_texto(case when it.i_tipo = 'vencido' then cfg.t_ven else cfg.t_rec end, jsonb_build_object(
      'nombre', coalesce((regexp_split_to_array(btrim(coalesce(it.nombre, '')), '\s+'))[1], ''),
      'habitacion', case when coalesce(it.habitacion, 0) = 0 then '—' when it.habitacion < 10 then '0' || it.habitacion else it.habitacion::text end,
      'monto', public.aviso_num(it.monto_mes),
      'deuda', public.aviso_num(it.e_deuda),
      'dias', it.e_dias::text,
      'fecha', to_char(it.i_vence, 'DD/MM/YYYY'),
      'mes', (array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])[substr(it.i_periodo, 6, 2)::int] || ' ' || substr(it.i_periodo, 1, 4),
      'yape', cfg.yape, 'inmueble', cfg.inmueble, 'pago', '')) as texto,
    case when length(it.cel) = 9 then '51' || it.cel when length(it.cel) >= 10 then it.cel else '' end as tel
  from items it cross join cfg
)
select m.tid, m.i_tipo, m.i_periodo, m.i_vence, m.i_deuda, m.i_dias, m.texto,
  case when m.tel = '' then '' else 'https://wa.me/' || m.tel || '?text=' || public.aviso_url(m.texto) end
from msg m
$$;
revoke all on function public.avisos_calcular(date) from public, anon, authenticated;
