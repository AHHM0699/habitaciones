'use strict';
// Recibo de pago de Sueño Feliz en PDF, tipo ticket de 80 mm (ticketera térmica). Se genera en el teléfono.
// Corto a propósito: un solo pago por recibo, correlativo propio (pagos.numero) y QR que valida el recibo.
const Recibo = (() => {
  const LOGO = { src: 'logos/suenofeliz-ticket.png', w: 894, h: 738, ancho: 36 };
  const PIE = 'Canjee este recibo por su BOLETA DE VENTA. Este documento no es un comprobante de pago con valor tributario.';

  // Medidas en mm. Papel de 80 mm; área imprimible típica de 72 mm.
  const W = 80, M = 4, R = W - M, C = W / 2, ANCHO = W - 2 * M;
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  const cargas = {};
  function script(src, listo) {
    if (listo()) return Promise.resolve();
    if (!cargas[src]) {
      cargas[src] = new Promise((ok, mal) => {
        const sc = document.createElement('script');
        sc.src = src;
        sc.onload = ok;
        sc.onerror = () => { delete cargas[src]; mal(new Error('No se pudo cargar el generador de PDF. Revisa tu conexión.')); };
        document.head.appendChild(sc);
      });
    }
    return cargas[src];
  }
  const cargarLib = () => Promise.all([
    script('vendor/jspdf.umd.min.js', () => !!window.jspdf),
    script('vendor/qrcode.js', () => typeof window.qrcode === 'function'),
  ]);

  let logoData = null;
  async function logo() {
    if (logoData) return logoData;
    const r = await fetch(LOGO.src);
    if (!r.ok) throw new Error('logo');
    const blob = await r.blob();
    logoData = await new Promise((ok, mal) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = mal; fr.readAsDataURL(blob); });
    return logoData;
  }

  // Las fuentes estándar del PDF solo cubren Latin-1
  const txt = (v) => String(v ?? '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E\xA1-\xFF\n]/g, '').trim();
  const soles = (n) => 'S/ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pad = (n) => String(n).padStart(2, '0');
  const fecha = (f) => { const [y, m, d] = String(f || '').slice(0, 10).split('-'); return d ? `${d}/${m}/${y}` : ''; };
  const limaFechaHora = (d) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
  };
  const codigoLegible = (c) => String(c || '').replace(/(.{5})(?=.)/g, '$1-');
  const alto = (pt) => pt * 0.3528 * 1.22;   // alto de línea en mm

  // Periodo que cubre el pago: del día de pago de ese mes al día anterior al siguiente día de pago
  const ultimoDia = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  function periodo(p, diaPago, ingreso) {
    const [y, m] = p.split('-').map(Number);
    const dia = Math.min(31, Math.max(1, +diaPago || 1));
    let ini = `${y}-${pad(m)}-${pad(Math.min(dia, ultimoDia(y, m)))}`;
    if (ingreso && ini < ingreso.slice(0, 10)) ini = ingreso.slice(0, 10);
    const y2 = m === 12 ? y + 1 : y, m2 = m === 12 ? 1 : m + 1;
    const sig = new Date(Date.UTC(y2, m2 - 1, Math.min(dia, ultimoDia(y2, m2))) - 864e5);
    const fin = `${sig.getUTCFullYear()}-${pad(sig.getUTCMonth() + 1)}-${pad(sig.getUTCDate())}`;
    return { mes: `${MESES[m - 1]} ${y}`, ini, fin };
  }

  /** pago: fila de pagos (firmada). inq: su inquilino. base: URL de la app. Devuelve { blob, nombre, titulo }. */
  async function generar(pago, inq, base) {
    if (!pago || (pago.estado && pago.estado !== 'firmado')) throw new Error('El recibo se habilita cuando se firme el pago');
    if (!pago.numero || !pago.codigo) throw new Error('Este pago aún no tiene número de recibo. Vuelve a abrir la app.');
    await cargarLib();
    const { jsPDF } = window.jspdf;
    let img = null;
    try { img = await logo(); } catch { /* sale sin logo */ }
    const per = periodo(pago.periodo, inq && inq.dia_pago, inq && inq.fecha_ingreso);
    const numero = `N° ${String(pago.numero).padStart(6, '0')}`;
    const url = `${base}verificar.html?c=${pago.codigo}`;
    const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();

    // Dibuja el ticket y devuelve el alto usado (se llama 2 veces: medir y dibujar)
    function dibujar(doc) {
      let y = M;
      const F = (estilo, tam) => { doc.setFont('helvetica', estilo); doc.setFontSize(tam); doc.setTextColor(0, 0, 0); };
      const centro = (texto, estilo, tam, ancho = ANCHO, x = C) => {
        F(estilo, tam);
        for (const l of doc.splitTextToSize(txt(texto), ancho)) { y += alto(tam); doc.text(l, x, y - alto(tam) * 0.22, { align: 'center' }); }
      };
      const linea = () => {
        y += 2;
        doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.25); doc.setLineDashPattern([0.9, 0.9], 0);
        doc.line(M, y, R, y); doc.setLineDashPattern([], 0);
        y += 1;
      };
      const par = (etq, valor, negrita = true, tam = 8.5) => {
        if (!txt(valor)) return;
        y += alto(tam) + 0.3;
        F('normal', tam); doc.text(etq, M, y - alto(tam) * 0.22);
        F(negrita ? 'bold' : 'normal', tam);
        const v = doc.splitTextToSize(txt(valor), ANCHO - doc.getTextWidth(etq) - 3)[0];
        doc.text(v, R, y - alto(tam) * 0.22, { align: 'right' });
      };

      // ----- Logo y documento -----
      if (img) {
        const w = LOGO.ancho, h = w * LOGO.h / LOGO.w;
        doc.addImage(img, 'PNG', C - w / 2, y, w, h);
        y += h + 1;
      }
      centro('RECIBO DE PAGO', 'bold', 11);
      centro(numero, 'bold', 10);

      // ----- Inquilino y alquiler -----
      linea();
      centro(inq ? inq.nombre : 'Inquilino', 'bold', 9.5);
      if (inq && inq.dni) centro(`DNI ${inq.dni}`, 'normal', 8);
      y += 0.5;
      par('Habitación', `N° ${pad(pago.habitacion)}`);
      par('Mes', per.mes);
      par('Desde', fecha(per.ini));
      par('Hasta', fecha(per.fin));

      // ----- Pago -----
      linea();
      centro(soles(pago.monto), 'bold', 16);
      par('Fecha de pago', fecha(pago.fecha));
      par('Medio de pago', pago.metodo || '-');
      par('Firmado por', pago.firmado_por || '-');
      if (pago.firmado_en) par('Firmado el', limaFechaHora(new Date(pago.firmado_en)), false, 8);

      // ----- Validador: QR a la izquierda, texto a la derecha -----
      linea();
      const n = qr.getModuleCount(), lado = 22, mod = lado / n, yq = y + 1.5;
      doc.setFillColor(0, 0, 0);
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) doc.rect(M + c * mod, yq + r * mod, mod + 0.02, mod + 0.02, 'F');
      const xt = M + lado + 3, at = R - xt;
      y = yq + 2;
      F('normal', 7.5); for (const l of doc.splitTextToSize('Escanee el código para verificar que este recibo es auténtico.', at)) { y += alto(7.5); doc.text(l, xt, y - alto(7.5) * 0.22); }
      y += 1;
      F('normal', 7); y += alto(7); doc.text('Código de validación', xt, y - alto(7) * 0.22);
      F('bold', 9.5); y += alto(9.5); doc.text(codigoLegible(pago.codigo), xt, y - alto(9.5) * 0.22);
      y = Math.max(y, yq + lado) + 1.5;

      // ----- Pie -----
      linea();
      centro(PIE, 'bold', 7.5);
      centro(`Emitido: ${limaFechaHora(new Date())}`, 'normal', 7);
      return y + M;
    }

    const medida = new jsPDF({ unit: 'mm', format: [W, 3000] });
    const h = Math.max(90, Math.ceil(dibujar(medida)));
    const doc = new jsPDF({ unit: 'mm', format: [W, h], compress: true });
    dibujar(doc);
    const cliente = txt(inq ? inq.nombre : '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const nombre = `Recibo-${String(pago.numero).padStart(6, '0')}${cliente ? '-' + cliente : ''}.pdf`;
    doc.setProperties({ title: `Recibo de pago ${numero}`, author: 'Sueño Feliz', creator: 'Habitaciones y Cobros' });
    return { blob: doc.output('blob'), nombre, titulo: `Recibo ${numero}` };
  }

  return { generar };
})();
