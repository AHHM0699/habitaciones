-- Aplicado en Supabase el 17/11/2026. Registro de referencia.
-- Pago de varios meses (pago masivo): p. ej. paga S/ 700 y su mensualidad es S/ 350 -> 2 meses.
--  * Se guarda como una fila por mes (así la deuda, los saldos, los avisos y el gráfico siguen calculándose por mes sin cambios)
--    y todas las filas comparten pagos.grupo. Los pagos de un solo mes siguen con grupo = null, igual que antes.
--  * registrar_pago_multiple guarda todas las filas juntas (todas o ninguna), con un solo PIN.
--  * firmar_pago y eliminar_pago, si el pago es parte de un grupo, firman/rechazan/eliminan el grupo entero.
--  * Un solo recibo por grupo: solo la primera fila firmada del grupo recibe número del correlativo.
--  * verificar_recibo devuelve el total y los meses del grupo.

alter table public.pagos add column if not exists grupo uuid;
create index if not exists pagos_grupo_idx on public.pagos (grupo) where grupo is not null;

-- Número de recibo: uno por pago; en un grupo, solo la primera fila que se firma
create or replace function public.tg_pago_numero() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.estado = 'firmado' and new.numero is null and (new.grupo is null or not exists (
      select 1 from public.pagos x where x.grupo = new.grupo and x.id <> new.id and x.numero is not null)) then
    new.numero := nextval('public.recibo_seq');
  end if;
  if new.codigo is null then new.codigo := public.codigo_recibo(); end if;
  return new;
end $$;
revoke all on function public.tg_pago_numero() from public, anon, authenticated;

-- p_items: [{"periodo":"2026-10","monto":350},{"periodo":"2026-11","monto":350}]
create or replace function public.registrar_pago_multiple(p_pin text, p_inquilino uuid, p_items jsonb, p_fecha date,
  p_metodo text default '', p_nota text default '', p_comprobante text default null, p_atendido text default '')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v record; t public.inquilinos; r public.pagos; it record; g uuid := gen_random_uuid(); filas jsonb := '[]'::jsonb;
  firma text := null; atendido text := nullif(trim(coalesce(p_atendido, '')), ''); n int; total numeric := 0;
begin
  if not public.es_activo() then return jsonb_build_object('error', 'Tu usuario no tiene permiso. Vuelve a entrar.'); end if;
  select * into t from public.inquilinos where id = p_inquilino;
  if t.id is null then return jsonb_build_object('error', 'Inquilino no encontrado'); end if;
  if jsonb_typeof(p_items) is distinct from 'array' then return jsonb_build_object('error', 'Faltan los meses'); end if;
  n := jsonb_array_length(p_items);
  if n < 2 or n > 36 then return jsonb_build_object('error', 'Un pago de varios meses debe cubrir entre 2 y 36 meses'); end if;
  for it in select x->>'periodo' as periodo, x->>'monto' as monto from jsonb_array_elements(p_items) x loop
    if coalesce(it.periodo, '') !~ '^\d{4}-(0[1-9]|1[0-2])$' then return jsonb_build_object('error', 'Mes inválido'); end if;
    if coalesce(it.monto, '') !~ '^\d+(\.\d+)?$' or it.monto::numeric <= 0 then return jsonb_build_object('error', 'Monto inválido'); end if;
    total := total + it.monto::numeric;
  end loop;
  if (select count(distinct x->>'periodo') from jsonb_array_elements(p_items) x) <> n then
    return jsonb_build_object('error', 'Hay meses repetidos');
  end if;
  if total > 1000000 then return jsonb_build_object('error', 'Monto inválido'); end if;
  if p_fecha is null then return jsonb_build_object('error', 'Falta la fecha'); end if;
  if coalesce(p_pin, '') <> '' then
    v := privado.verificar_pin(p_pin);
    if v.nombre is null then return jsonb_build_object('error', v.error); end if;
    firma := v.nombre;
  elsif atendido is null then
    return jsonb_build_object('error', 'Escribe quién atendió');
  end if;
  -- Una fila por mes, en orden: la primera (el mes más antiguo) lleva el número de recibo
  for it in select x->>'periodo' as periodo, round((x->>'monto')::numeric, 2) as monto
      from jsonb_array_elements(p_items) x order by x->>'periodo' loop
    insert into public.pagos (inquilino_id, habitacion, periodo, monto, fecha, metodo, nota, comprobante, registrado_por,
        estado, atendido_por, firmado_por, firmado_en, grupo)
      values (t.id, t.habitacion, it.periodo, it.monto, p_fecha, coalesce(p_metodo, ''), coalesce(p_nota, ''), p_comprobante,
        auth.uid(), case when firma is null then 'por_firmar' else 'firmado' end, left(atendido, 40), firma,
        case when firma is null then null else now() end, g)
      returning * into r;
    filas := filas || to_jsonb(r);
  end loop;
  return jsonb_build_object('pago', filas->0, 'pagos', filas);
end $$;

create or replace function public.firmar_pago(p_pin text, p_id uuid, p_rechazar boolean default false, p_motivo text default '')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v record; r public.pagos; f public.pagos; filas jsonb := '[]'::jsonb; v_motivo text := nullif(trim(coalesce(p_motivo, '')), '');
begin
  if not public.es_activo() then return jsonb_build_object('error', 'Tu usuario no tiene permiso. Vuelve a entrar.'); end if;
  select * into r from public.pagos where id = p_id;
  if r.id is null then return jsonb_build_object('error', 'Pago no encontrado'); end if;
  -- Bloquea el pago (o todo su grupo) para que dos personas no lo firmen a la vez
  perform 1 from public.pagos x where x.id = p_id or (r.grupo is not null and x.grupo = r.grupo) for update;
  select * into r from public.pagos where id = p_id;
  if r.estado <> 'por_firmar' then
    return jsonb_build_object('error', case when r.estado = 'firmado' then 'Este pago ya está firmado' else 'Este pago fue rechazado' end);
  end if;
  if p_rechazar and (v_motivo is null or length(v_motivo) < 3) then return jsonb_build_object('error', 'Escribe el motivo del rechazo'); end if;
  v := privado.verificar_pin(p_pin);
  if v.nombre is null then return jsonb_build_object('error', v.error); end if;
  -- Fila por fila y en orden de mes, para que el número de recibo quede en la primera del grupo
  for f in select * from public.pagos x where (x.id = p_id or (r.grupo is not null and x.grupo = r.grupo)) and x.estado = 'por_firmar'
      order by x.periodo loop
    update public.pagos set estado = case when p_rechazar then 'rechazado' else 'firmado' end,
        firmado_por = v.nombre, firmado_en = now(), motivo = case when p_rechazar then left(v_motivo, 200) else null end
      where id = f.id
      returning * into f;
    filas := filas || to_jsonb(f);
  end loop;
  select * into r from public.pagos where id = p_id;
  return jsonb_build_object('pago', to_jsonb(r), 'pagos', filas);
end $$;

create or replace function public.eliminar_pago(p_pin text, p_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v record; r public.pagos; ids jsonb; comps jsonb;
begin
  if not public.es_activo() then return jsonb_build_object('error', 'Tu usuario no tiene permiso. Vuelve a entrar.'); end if;
  select * into r from public.pagos where id = p_id;
  if r.id is null then return jsonb_build_object('error', 'Pago no encontrado'); end if;
  v := privado.verificar_pin(p_pin);
  if v.nombre is null then return jsonb_build_object('error', v.error); end if;
  with d as (delete from public.pagos x where x.id = p_id or (r.grupo is not null and x.grupo = r.grupo) returning x.id, x.comprobante)
  select coalesce(jsonb_agg(d.id), '[]'::jsonb), coalesce(jsonb_agg(distinct d.comprobante) filter (where d.comprobante is not null), '[]'::jsonb)
    into ids, comps from d;
  return jsonb_build_object('ok', true, 'comprobante', r.comprobante, 'comprobantes', comps, 'ids', ids, 'por', v.nombre);
end $$;

-- Página pública de verificación: en un grupo muestra el total y los meses que cubre
create or replace function public.verificar_recibo(p_codigo text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare p public.pagos; t public.inquilinos; y int; m int; dia int; ini date; fin date; nom text;
  p_ini text; p_fin text; total numeric; meses int; num int;
begin
  select * into p from public.pagos where codigo = upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));
  if p.id is null then return jsonb_build_object('existe', false); end if;
  select * into t from public.inquilinos where id = p.inquilino_id;
  if p.grupo is null then
    p_ini := p.periodo; p_fin := p.periodo; total := p.monto; meses := 1; num := p.numero;
  else
    select min(x.periodo), max(x.periodo), sum(x.monto), count(*), max(x.numero) into p_ini, p_fin, total, meses, num
      from public.pagos x where x.grupo = p.grupo;
  end if;
  dia := least(31, greatest(1, coalesce(t.dia_pago, 1)));
  y := split_part(p_ini, '-', 1)::int; m := split_part(p_ini, '-', 2)::int;
  ini := make_date(y, m, least(dia, extract(day from (make_date(y, m, 1) + interval '1 month' - interval '1 day'))::int));
  if t.fecha_ingreso is not null and ini < t.fecha_ingreso then ini := t.fecha_ingreso; end if;
  y := split_part(p_fin, '-', 1)::int; m := split_part(p_fin, '-', 2)::int;
  fin := make_date(extract(year from make_date(y, m, 1) + interval '1 month')::int, extract(month from make_date(y, m, 1) + interval '1 month')::int,
    least(dia, extract(day from (make_date(y, m, 1) + interval '2 month' - interval '1 day'))::int)) - 1;
  -- "MARÍA FERNANDA NUÑEZ" -> "María F. N."
  select string_agg(case when i = 1 then initcap(w) else upper(left(w, 1)) || '.' end, ' ' order by i) into nom
    from unnest(regexp_split_to_array(trim(coalesce(t.nombre, '')), '\s+')) with ordinality as a(w, i);
  return jsonb_build_object('existe', true, 'estado', p.estado, 'numero', num, 'fecha', p.fecha, 'monto', total,
    'metodo', p.metodo, 'periodo', p_ini, 'periodo_hasta', p_fin, 'meses', meses, 'habitacion', p.habitacion, 'cliente', nom,
    'inicio', ini, 'fin', fin, 'firmado_por', p.firmado_por, 'firmado_en', p.firmado_en);
end $$;

revoke all on function public.registrar_pago_multiple(text, uuid, jsonb, date, text, text, text, text) from public, anon;
grant execute on function public.registrar_pago_multiple(text, uuid, jsonb, date, text, text, text, text) to authenticated;
revoke all on function public.firmar_pago(text, uuid, boolean, text) from public, anon;
revoke all on function public.eliminar_pago(text, uuid) from public, anon;
grant execute on function public.firmar_pago(text, uuid, boolean, text) to authenticated;
grant execute on function public.eliminar_pago(text, uuid) to authenticated;
grant execute on function public.verificar_recibo(text) to anon, authenticated;
