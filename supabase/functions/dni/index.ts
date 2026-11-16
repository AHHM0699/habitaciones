// Consulta DNI para la app. Claves en el Vault de Supabase (nunca en el repo, que es público):
//   dni_endpointpe (principal, gratis 150/mes)  ·  dni_apiinti (respaldo, gratis 100/mes)
// Se leen con la RPC public.dni_claves(), que solo puede ejecutar service_role.
// Antes de gastar una consulta se busca el DNI entre los inquilinos ya registrados.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PROVEEDORES = [
  { vault: "dni_endpointpe", url: "https://api.endpoint.pe/v1/dni/" },
  { vault: "dni_apiinti", url: "https://app.apiinti.dev/api/v1/dni/" },
];

// deno-lint-ignore no-explicit-any
function datos(j: any) {
  const d = j?.data && typeof j.data === "object" ? j.data : (j ?? {});
  const r = {
    nombres: d.nombres ?? d.first_name ?? "",
    apellido_paterno: d.apellido_paterno ?? d.apellidoPaterno ?? d.first_last_name ?? "",
    apellido_materno: d.apellido_materno ?? d.apellidoMaterno ?? d.second_last_name ?? "",
    nombre_completo: d.nombre_completo ?? d.nombreCompleto ?? d.full_name ?? "",
  };
  if (!r.nombre_completo) r.nombre_completo = [r.nombres, r.apellido_paterno, r.apellido_materno].filter(Boolean).join(" ");
  return r;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "metodo" }, 405);

  // Solo usuarios activos de la app pueden consultar
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: activo } = await sb.rpc("es_activo");
  if (activo !== true) return json({ error: "no_autorizado" }, 403);

  let dni = "";
  try { dni = String((await req.json()).dni ?? "").trim(); } catch { /* cuerpo inválido */ }
  if (!/^\d{8}$/.test(dni)) return json({ error: "dni_invalido" }, 400);

  // ¿Ya fue inquilino? Entonces no se gasta consulta
  const { data: previo } = await sb.from("inquilinos").select("nombre").eq("dni", dni).limit(1).maybeSingle();
  if (previo?.nombre) return json({ dni, nombre_completo: previo.nombre, fuente: "inquilino" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: claves } = await admin.rpc("dni_claves");
  const mapa = new Map((claves ?? []).map((c: { proveedor: string; clave: string }) => [c.proveedor, c.clave] as [string, string]));
  const provs = PROVEEDORES.map((p) => ({ ...p, t: mapa.get(p.vault) })).filter((p) => p.t);
  if (!provs.length) return json({ error: "sin_token" }, 503);

  let agotados = 0, caidos = 0;
  for (const p of provs) {
    let r: Response, j: unknown;
    try {
      r = await fetch(p.url + dni, { headers: { Authorization: `Bearer ${p.t}`, Accept: "application/json" } });
      j = await r.json().catch(() => null);
    } catch { caidos++; continue; }
    if (r.status === 404) return json({ error: "no_encontrado" }, 404);
    // deno-lint-ignore no-explicit-any
    if (r.ok && j && (j as any).success !== false) {
      const d = datos(j);
      if (!d.nombre_completo.trim()) return json({ error: "no_encontrado" }, 404);
      return json({ dni, ...d, fuente: "reniec" });
    }
    if ([401, 402, 403, 429].includes(r.status)) agotados++; else caidos++;
  }
  return json({ error: agotados && !caidos ? "agotado" : "servicio_caido" }, 502);
});
