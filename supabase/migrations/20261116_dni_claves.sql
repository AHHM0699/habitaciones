-- Claves de consulta DNI (endpoint.pe y ApiInti) en el Vault. Aplicada el 16/11/2026.
-- Las claves NO van aquí (repo público): se cargaron aparte con
--   select vault.create_secret('<clave>', 'dni_endpointpe', '...');
--   select vault.create_secret('<clave>', 'dni_apiinti', '...');
-- Para cambiar una: select vault.update_secret((select id from vault.secrets where name='dni_apiinti'), '<nueva>');
create or replace function public.dni_claves()
returns table(proveedor text, clave text)
language sql security definer set search_path = ''
as $$ select name, decrypted_secret from vault.decrypted_secrets where name in ('dni_endpointpe','dni_apiinti') $$;
revoke all on function public.dni_claves() from public, anon, authenticated;
grant execute on function public.dni_claves() to service_role;
