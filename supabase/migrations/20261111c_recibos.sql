-- Aplicado en Supabase el 11/11/2026. Registro de referencia.
-- Recibos de pago de Habitaciones (Sueño Feliz):
--  * Correlativo PROPIO (recibo_seq), independiente de Separaciones. Se asigna solo cuando el pago queda FIRMADO
--    (los por firmar y rechazados no gastan número). Los pagos firmados que ya existían se numeran por fecha de pago.
--  * Código validador por pago (10 caracteres) que va en el QR del recibo.
--  * verificar_recibo(código): página pública verificar.html confirma si el recibo es auténtico (datos mínimos).

alter table public.pagos add column if not exists numero int;
alter table public.pagos add column if not exists codigo text;
create unique index if not exists pagos_numero_uq on public.pagos (numero);
create unique index if not exists pagos_codigo_uq on public.pagos (codigo);
create sequence if not exists public.recibo_seq;

-- Código sin letras que se confundan (sin 0/O, 1/I/L)
create or replace function public.codigo_recibo() returns text
language sql volatile set search_path to '' as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 31), 1), '' order by i)
  from (select extensions.gen_random_bytes(10) as b) x, generate_series(0, 9) i
$$;
alter table public.pagos alter column codigo set default public.codigo_recibo();
update public.pagos set codigo = public.codigo_recibo() where codigo is null;

-- Pagos firmados que ya existían: número por fecha de pago
with o as (select id, row_number() over (order by fecha, creado) n from public.pagos where estado = 'firmado' and numero is null)
update public.pagos p set numero = o.n from o where p.id = o.id;
select setval('public.recibo_seq', coalesce((select max(numero) from public.pagos), 0) + 1, false);

create or replace function public.tg_pago_numero() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.estado = 'firmado' and new.numero is null then new.numero := nextval('public.recibo_seq'); end if;
  if new.codigo is null then new.codigo := public.codigo_recibo(); end if;
  return new;
end $$;
revoke all on function public.tg_pago_numero() from public, anon, authenticated;
drop trigger if exists pagos_numero on public.pagos;
create trigger pagos_numero before insert or update of estado on public.pagos
  for each row execute function public.tg_pago_numero();

-- Página pública de verificación (QR del recibo)
create or replace function public.verificar_recibo(p_codigo text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare p public.pagos; t public.inquilinos; y int; m int; dia int; ini date; fin date; nom text;
begin
  select * into p from public.pagos where codigo = upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));
  if p.id is null then return jsonb_build_object('existe', false); end if;
  select * into t from public.inquilinos where id = p.inquilino_id;
  y := split_part(p.periodo, '-', 1)::int; m := split_part(p.periodo, '-', 2)::int;
  dia := least(31, greatest(1, coalesce(t.dia_pago, 1)));
  ini := make_date(y, m, least(dia, extract(day from (make_date(y, m, 1) + interval '1 month' - interval '1 day'))::int));
  if t.fecha_ingreso is not null and ini < t.fecha_ingreso then ini := t.fecha_ingreso; end if;
  fin := make_date(extract(year from make_date(y, m, 1) + interval '1 month')::int, extract(month from make_date(y, m, 1) + interval '1 month')::int,
    least(dia, extract(day from (make_date(y, m, 1) + interval '2 month' - interval '1 day'))::int)) - 1;
  -- "MARÍA FERNANDA NUÑEZ" -> "María F. N."
  select string_agg(case when i = 1 then initcap(w) else upper(left(w, 1)) || '.' end, ' ' order by i) into nom
    from unnest(regexp_split_to_array(trim(coalesce(t.nombre, '')), '\s+')) with ordinality as a(w, i);
  return jsonb_build_object('existe', true, 'estado', p.estado, 'numero', p.numero, 'fecha', p.fecha, 'monto', p.monto,
    'metodo', p.metodo, 'periodo', p.periodo, 'habitacion', p.habitacion, 'cliente', nom, 'inicio', ini, 'fin', fin,
    'firmado_por', p.firmado_por, 'firmado_en', p.firmado_en);
end $$;
revoke all on function public.verificar_recibo(text) from public;
grant execute on function public.verificar_recibo(text) to anon, authenticated;
