import { createClient } from "npm:@supabase/supabase-js@2.117.3";

// Avisos de cobro por WhatsApp (API oficial de Meta).
// - modo "diario": lo llama la tarea programada a las 9:00 a. m. Envía solos el aviso
//   de N días antes y el del día de vencimiento; los atrasos quedan "pendientes"
//   hasta que alguien confirme en la app que no hubo pago.
// - modo "enviar": lo llama la app al confirmar un atraso; vuelve a revisar la deuda y envía.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Plantillas aprobadas en WhatsApp Manager (idioma: español "es")
const PLANTILLA = {
  previo: "alquiler_recordatorio",
  hoy: "alquiler_vence_hoy",
  vencido: "alquiler_vencido",
  dueno: "aviso_atrasos",
};
const IDIOMA = "es";

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const pad = (n: number) => String(n).padStart(2, "0");
const r2 = (n: unknown) => Math.round((+(n as number) || 0) * 100) / 100;
const dn = (s: string) => { const a = s.split("-").map(Number); return Math.round(Date.UTC(a[0], a[1] - 1, a[2] || 1) / 864e5); };
const nstr = (n: number) => { const d = new Date(n * 864e5); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); };
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pAdd = (p: string, k: number) => { let [y, m] = p.split("-").map(Number); m += k; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return y + "-" + pad(m); };
const dueOf = (p: string, dia: number) => { const [y, m] = p.split("-").map(Number); return dn(p + "-" + pad(Math.min(dia, dim(y, m)))); };
const pLabel = (p: string) => { const [y, m] = p.split("-").map(Number); return MESES[m - 1] + " " + y; };
const fmtFull = (n: number) => { const s = nstr(n); return s.slice(8) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4); };
const fmtN = (n: number) => { n = r2(n); return n % 1 ? n.toFixed(2) : String(n); };
const pad2 = (n: number) => (n ? pad(n) : "—");
const primerNombre = (s: string) => (s || "").trim().split(/\s+/)[0] || "";
// Fecha de hoy en Perú (UTC-5, sin horario de verano)
const hoyLima = () => nstr(Math.floor((Date.now() - 5 * 3600e3) / 864e5));
function waPhone(c: string) { let d = String(c || "").replace(/\D/g, ""); if (d.length === 9) d = "51" + d; return d.length >= 10 ? d : ""; }

type Tenant = { id: string; nombre: string; celular: string; habitacion: number; monto: number; dia_pago: number; fecha_ingreso: string; activo: boolean };
type Periodo = { p: string; due: number; saldo: number };

// Mismo cálculo que la app (statusOf)
function estadoDe(t: Tenant, pagado: Map<string, number>, T: number) {
  const dia = Math.min(31, Math.max(1, +t.dia_pago || 1)), monto = +t.monto || 0, ing = dn(t.fecha_ingreso);
  const per: Periodo[] = [];
  let p = t.fecha_ingreso.slice(0, 7);
  for (let i = 0; i < 600; i++) {
    const due = Math.max(dueOf(p, dia), ing);
    if (due > T + 62) break;
    per.push({ p, due, saldo: Math.max(0, r2(monto - (pagado.get(t.id + "|" + p) || 0))) });
    p = pAdd(p, 1);
  }
  const venc = per.filter((x) => x.due < T && x.saldo > 0), hoyP = per.find((x) => x.due === T && x.saldo > 0);
  const deuda = r2(venc.reduce((a, x) => a + x.saldo, 0) + (hoyP ? hoyP.saldo : 0));
  return { per, venc, hoyP, deuda, dias: venc.length ? T - venc[0].due : 0 };
}

async function enviarWA(to: string, plantilla: string, params: string[]) {
  const token = Deno.env.get("WHATSAPP_TOKEN"), phoneId = Deno.env.get("WHATSAPP_PHONE_ID");
  if (!token || !phoneId) return { ok: false, detalle: "Falta configurar WhatsApp (token o número)" };
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: plantilla,
          language: { code: IDIOMA },
          components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text: text.replace(/\s+/g, " ").trim() || "-" })) }],
        },
      }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, detalle: String(j?.error?.message || "Error " + r.status).slice(0, 300) };
    return { ok: true, detalle: String(j?.messages?.[0]?.id || "") };
  } catch (e) {
    return { ok: false, detalle: "Sin conexión con WhatsApp: " + String(e).slice(0, 200) };
  }
}

const paramsVencido = (t: Tenant, e: ReturnType<typeof estadoDe>, yape: string) =>
  [primerNombre(t.nombre), pad2(t.habitacion), fmtFull(e.venc[0].due), String(e.dias), fmtN(e.deuda), yape];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "metodo" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cuerpo vacío */ }
  const modo = String(body.modo || "");

  // Quién llama: la tarea programada (clave secreta) o un usuario activo de la app
  const cron = req.headers.get("x-cron");
  if (cron) {
    const { data: ok } = await admin.rpc("avisos_clave_ok", { p: cron });
    if (ok !== true) return json({ error: "no_autorizado" }, 403);
  } else {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: activo } = await sb.rpc("es_activo");
    if (activo !== true) return json({ error: "no_autorizado" }, 403);
    if (modo === "diario") return json({ error: "no_autorizado" }, 403);
  }

  const { data: cfg } = await admin.from("config").select("*").eq("id", 1).maybeSingle();
  if (!cfg) return json({ error: "sin_config" }, 500);
  const yape = String(cfg.yape || "").trim() || "-";
  const HOY = hoyLima(), T = dn(HOY);

  async function datosDe(ids?: string[]) {
    let q = admin.from("inquilinos").select("*").eq("activo", true);
    if (ids) q = q.in("id", ids);
    const { data: ts, error } = await q;
    if (error) throw error;
    const pagado = new Map<string, number>();
    if (ts && ts.length) {
      const { data: ps, error: e2 } = await admin.from("pagos").select("inquilino_id,periodo,monto").in("inquilino_id", ts.map((t) => t.id));
      if (e2) throw e2;
      for (const p of ps || []) { const k = p.inquilino_id + "|" + p.periodo; pagado.set(k, r2((pagado.get(k) || 0) + (+p.monto || 0))); }
    }
    return { ts: (ts || []).filter((t) => t.fecha_ingreso) as Tenant[], pagado };
  }

  // ---------- Confirmación desde la app: enviar aviso de atraso ----------
  if (modo === "enviar") {
    const id = String(body.id || "");
    const { data: av } = await admin.from("avisos").select("*").eq("id", id).maybeSingle();
    if (!av || av.tipo !== "vencido") return json({ error: "no_encontrado" }, 404);
    if (av.estado === "enviado") return json({ error: "ya_enviado" }, 409);
    const { ts, pagado } = await datosDe([av.inquilino_id]);
    const t = ts[0];
    if (!t) return json({ error: "no_encontrado" }, 404);
    const e = estadoDe(t, pagado, T);
    if (!e.venc.length) {
      await admin.from("avisos").update({ estado: "pagado", detalle: "Ya no tiene deuda vencida", actualizado: new Date().toISOString() }).eq("id", id);
      return json({ pagado: true });
    }
    const to = waPhone(t.celular);
    const r = to ? await enviarWA(to, PLANTILLA.vencido, paramsVencido(t, e, yape)) : { ok: false, detalle: "Sin celular válido" };
    await admin.from("avisos").update({ estado: r.ok ? "enviado" : "error", detalle: r.detalle, deuda: e.deuda, dias: e.dias, actualizado: new Date().toISOString() }).eq("id", id);
    return r.ok ? json({ enviado: true }) : json({ error: "envio", detalle: r.detalle }, 502);
  }

  // ---------- Tarea diaria ----------
  if (modo !== "diario") return json({ error: "modo" }, 400);
  if (!cfg.auto_activo) return json({ omitido: "desactivado" });

  // Las preguntas de días anteriores que nadie respondió ya no aplican
  await admin.from("avisos").update({ estado: "caducado", actualizado: new Date().toISOString() }).eq("estado", "pendiente").lt("fecha", HOY);

  const previo = Math.min(15, Math.max(1, +cfg.auto_previo || 5));
  const { ts, pagado } = await datosDe();
  const res = { enviados: 0, errores: 0, pendientes: 0 };
  const atrasados: string[] = [];

  // Reserva el aviso del día (evita duplicados si la tarea corre dos veces)
  async function reservar(row: Record<string, unknown>) {
    const { data } = await admin.from("avisos").upsert(row, { onConflict: "inquilino_id,tipo,fecha", ignoreDuplicates: true }).select();
    return data && data[0];
  }

  for (const t of ts) {
    const e = estadoDe(t, pagado, T);
    const to = waPhone(t.celular);
    const auto: Array<{ tipo: "previo" | "hoy"; x: Periodo }> = [];
    const px = e.per.find((x) => x.due - T === previo && x.saldo > 0);
    if (px) auto.push({ tipo: "previo", x: px });
    if (e.hoyP) auto.push({ tipo: "hoy", x: e.hoyP });

    for (const { tipo, x } of auto) {
      const row = await reservar({ inquilino_id: t.id, periodo: x.p, tipo, fecha: HOY, estado: "error", detalle: "Enviando…", deuda: x.saldo });
      if (!row) continue;
      const params = tipo === "previo"
        ? [primerNombre(t.nombre), pad2(t.habitacion), pLabel(x.p), fmtN(x.saldo), fmtFull(x.due), yape]
        : [primerNombre(t.nombre), pad2(t.habitacion), pLabel(x.p), fmtN(x.saldo), yape];
      const r = to ? await enviarWA(to, PLANTILLA[tipo], params) : { ok: false, detalle: "Sin celular válido" };
      await admin.from("avisos").update({ estado: r.ok ? "enviado" : "error", detalle: r.detalle, actualizado: new Date().toISOString() }).eq("id", row.id);
      r.ok ? res.enviados++ : res.errores++;
    }

    if (e.venc.length) {
      const row = await reservar({ inquilino_id: t.id, periodo: e.venc[0].p, tipo: "vencido", fecha: HOY, estado: "pendiente", deuda: e.deuda, dias: e.dias });
      if (row) { res.pendientes++; atrasados.push(`${primerNombre(t.nombre)} (hab. ${pad2(t.habitacion)}, ${e.dias} d)`); }
    }
  }

  // Avisa a quien administra que hay atrasos por confirmar antes de enviar los avisos de atraso
  const dueno = waPhone(cfg.aviso_celular);
  if (atrasados.length && dueno) {
    const r = await enviarWA(dueno, PLANTILLA.dueno, [String(atrasados.length), atrasados.join(", ")]);
    await admin.from("avisos").insert({ tipo: "dueno", fecha: HOY, estado: r.ok ? "enviado" : "error", detalle: r.detalle, dias: atrasados.length });
  }
  return json({ fecha: HOY, ...res });
});
