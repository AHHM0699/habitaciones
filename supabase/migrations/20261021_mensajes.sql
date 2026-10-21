-- Aplicado en Supabase el 21/10/2026. Registro de referencia.
-- Mensaje propio para el día de vencimiento y textos más claros.

alter table public.config add column if not exists t_hoy text not null default '';
update public.config set
  t_recordatorio = 'Hola {nombre}, te escribimos para recordarte que el alquiler de tu habitación (N.° {habitacion}) correspondiente a {mes} vence el {fecha}. El monto es S/ {monto}. Puedes pagar por Yape al {yape}, a nombre de Liliana Montenegro Fiestas. ¡Gracias!',
  t_hoy = 'Hola {nombre}, te recordamos que hoy vence el alquiler de tu habitación (N.° {habitacion}) correspondiente a {mes}. El monto es S/ {monto}. Puedes pagar por Yape al {yape}, a nombre de Liliana Montenegro Fiestas. ¡Gracias!',
  t_vencido = 'Hola {nombre}, el alquiler de tu habitación (N.° {habitacion}) venció el {fecha} y ya lleva {dias} de atraso. El monto pendiente es S/ {deuda}. Por favor, regulariza tu pago lo antes posible. Puedes pagar por Yape al {yape}, a nombre de Liliana Montenegro Fiestas. Gracias.',
  t_gracias = 'Hola {nombre}, te confirmo que recibí tu pago de S/ {pago} por el alquiler de tu habitación (N.° {habitacion}) correspondiente a {mes}. ¡Muchas gracias!'
where id = 1;

create or replace function public.avisos_calcular(hoy date)
returns table (inquilino_id uuid, tipo text, periodo text, vence date, deuda numeric, dias int, mensaje text, enlace text)
language sql stable security definer set search_path to '' as $$
with cfg as (
  select least(15, greatest(1, coalesce(c.auto_previo, 5))) as previo,
    coalesce(nullif(c.t_recordatorio, ''), 'Hola {nombre}, te escribimos para recordarte que el alquiler de tu habitación (N.° {habitacion}) correspondiente a {mes} vence el {fecha}. El monto es S/ {monto}. Puedes pagar por Yape al {yape}, a nombre de Liliana Montenegro Fiestas. ¡Gracias!') as t_rec,
    coalesce(nullif(c.t_hoy, ''), 'Hola {nombre}, te recordamos que hoy vence el alquiler de tu habitación (N.° {habitacion}) correspondiente a {mes}. El monto es S/ {monto}. Puedes pagar por Yape al {yape}, a nombre de Liliana Montenegro Fiestas. ¡Gracias!') as t_hoy,
    coalesce(nullif(c.t_vencido, ''), 'Hola {nombre}, el alquiler de tu habitación (N.° {habitacion}) venció el {fecha} y ya lleva {dias} de atraso. El monto pendiente es S/ {deuda}. Por favor, regulariza tu pago lo antes posible. Puedes pagar por Yape al {yape}, a nombre de Liliana Montenegro Fiestas. Gracias.') as t_ven,
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
    public.aviso_texto(case it.i_tipo when 'vencido' then cfg.t_ven when 'hoy' then cfg.t_hoy else cfg.t_rec end, jsonb_build_object(
      'nombre', coalesce((regexp_split_to_array(btrim(coalesce(it.nombre, '')), '\s+'))[1], ''),
      'habitacion', case when coalesce(it.habitacion, 0) = 0 then '—' when it.habitacion < 10 then '0' || it.habitacion else it.habitacion::text end,
      'monto', public.aviso_num(it.monto_mes),
      'deuda', public.aviso_num(it.e_deuda),
      'dias', it.e_dias || case when it.e_dias = 1 then ' día' else ' días' end,
      'fecha', to_char(it.i_vence, 'DD/MM/YYYY'),
      'mes', (array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])[substr(it.i_periodo, 6, 2)::int] || ' de ' || substr(it.i_periodo, 1, 4),
      'yape', cfg.yape, 'inmueble', cfg.inmueble, 'pago', '')) as texto,
    case when length(it.cel) = 9 then '51' || it.cel when length(it.cel) >= 10 then it.cel else '' end as tel
  from items it cross join cfg
)
select m.tid, m.i_tipo, m.i_periodo, m.i_vence, m.i_deuda, m.i_dias, m.texto,
  case when m.tel = '' then '' else 'https://wa.me/' || m.tel || '?text=' || public.aviso_url(m.texto) end
from msg m
$$;
revoke all on function public.avisos_calcular(date) from public, anon, authenticated;
