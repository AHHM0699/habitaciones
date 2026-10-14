(function(){
'use strict';

/* ============================================================
   CONEXIÓN
   ============================================================ */
const SUPABASE_URL='https://uscgdhqfpzopyzoeydjn.supabase.co';
const SUPABASE_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzY2dkaHFmcHpvcHl6b2V5ZGpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5MDc5MTIsImV4cCI6MjEwNzQ4MzkxMn0.nMwX0UnNj2mo-j_NmlXDhSpARxKXtFrVXKUuShRIFkU';
// Debe coincidir con la función "usuarios": el código de bloqueo es la contraseña de la cuenta compartida
const DOMINIO='usuarios.habitaciones.app';
const claveDe=code=>'hab#'+code+'#pin';
const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true,storageKey:'hc-sesion'}});

/* ============================================================
   CONSTANTES Y ESTADO
   ============================================================ */
const MESES=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MES3=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const DEFAULTS={nombre:'',yape:'999663869',dias_aviso:3,precio_base:350,
  t_recordatorio:'Hola {nombre}, te recuerdo que el alquiler de la habitación {habitacion} de {mes} (S/ {monto}) vence el {fecha}. Puedes pagar por Yape al {yape} (a nombre de Liliana Montenegro Fiestas). ¡Gracias!',
  t_vencido:'Hola {nombre}, el alquiler de la habitación {habitacion} venció el {fecha} y lleva {dias} días de atraso. El monto pendiente es S/ {deuda}. Por favor regulariza tu pago lo antes posible. Yape: {yape} (a nombre de Liliana Montenegro Fiestas). Gracias.',
  t_gracias:'Hola {nombre}, confirmo que recibí tu pago de S/ {pago} por la habitación {habitacion} ({mes}). ¡Gracias!'};
const EST={vencido:{label:'Vencido',icon:'▲',ord:0},hoy:{label:'Vence hoy',icon:'●',ord:1},porVencer:{label:'Por vencer',icon:'◐',ord:2},alDia:{label:'Al día',icon:'✓',ord:3},libre:{label:'Libre',icon:'○',ord:4}};
const METODOS=['Efectivo','Yape','Plin','Transferencia','Otro'];

const S={view:'inicio',config:null,rooms:[],tenants:[],pagos:[],notas:[],perfiles:[],yo:null,loaded:false,
  calP:null,calDay:null,pagP:null,showRet:false,q:'',shown:null};

/* ============================================================
   UTILIDADES
   ============================================================ */
const $=id=>document.getElementById(id);
const pad=n=>String(n).padStart(2,'0');
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const r2=n=>Math.round((+n||0)*100)/100;
const fmtN=n=>{n=r2(n);return n%1?n.toLocaleString('es-PE',{minimumFractionDigits:2,maximumFractionDigits:2}):n.toLocaleString('es-PE')};
const money=n=>'S/ '+fmtN(n);
function hoyStr(){const d=new Date();return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
let HOY=hoyStr();
const dn=s=>{const a=s.split('-').map(Number);return Math.round(Date.UTC(a[0],a[1]-1,a[2]||1)/864e5)};
const nstr=n=>{const d=new Date(n*864e5);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())};
const dim=(y,m)=>new Date(Date.UTC(y,m,0)).getUTCDate();
function pAdd(p,k){let [y,m]=p.split('-').map(Number);m+=k;while(m>12){m-=12;y++}while(m<1){m+=12;y--}return y+'-'+pad(m)}
function dueOf(p,dia){const [y,m]=p.split('-').map(Number);return dn(p+'-'+pad(Math.min(dia,dim(y,m))))}
const pLabel=p=>{const [y,m]=p.split('-').map(Number);return MESES[m-1]+' '+y};
const fmtD=n=>{const s=nstr(n);return s.slice(8)+'/'+s.slice(5,7)};
const fmtFull=n=>{const s=nstr(n);return s.slice(8)+'/'+s.slice(5,7)+'/'+s.slice(0,4)};
const fmtS=s=>s?s.slice(8,10)+'/'+s.slice(5,7)+'/'+s.slice(0,4):'—';
const curP=()=>HOY.slice(0,7);
const cfg=()=>Object.assign({},DEFAULTS,S.config||{});
const roomByNum=n=>S.rooms.find(r=>r.numero===+n);
const roomNo=n=>n?pad(n):'—';
const tenantById=id=>S.tenants.find(t=>t.id===id);
const perfilNombre=id=>{const p=S.perfiles.find(x=>x.id===id);return p?p.nombre:'Otra persona'};
function waPhone(c){let d=String(c||'').replace(/\D/g,'');if(d.length===9)d='51'+d;return d.length>=10?d:''}
function titleCase(s){const low=['de','del','la','las','los','y'];return String(s||'').toLowerCase().split(/\s+/).filter(Boolean).map((w,i)=>i&&low.includes(w)?w:w.charAt(0).toUpperCase()+w.slice(1)).join(' ')}
function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
function lsSet(k,v){try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch(e){}}

/* ============================================================
   CÁLCULO DE ESTADOS
   ============================================================ */
let PAID=new Map(),ST=new Map(),ROOMT=new Map();
function recompute(){
  PAID=new Map();
  for(const p of S.pagos){const k=p.inquilino_id+'|'+p.periodo;PAID.set(k,r2((PAID.get(k)||0)+(+p.monto||0)))}
  ST=new Map();ROOMT=new Map();
  for(const t of S.tenants){if(t.activo&&t.fecha_ingreso){ST.set(t.id,statusOf(t));ROOMT.set(t.habitacion,t)}}
}
function statusOf(t){
  const T=dn(HOY),aviso=+cfg().dias_aviso||0,dia=Math.min(31,Math.max(1,+t.dia_pago||1)),monto=+t.monto||0,ing=dn(t.fecha_ingreso);
  const per=[];let p=t.fecha_ingreso.slice(0,7);
  for(let i=0;i<600;i++){
    const due=Math.max(dueOf(p,dia),ing);if(due>T+62)break;
    const pagado=PAID.get(t.id+'|'+p)||0;
    per.push({p,due,pagado,saldo:Math.max(0,r2(monto-pagado))});p=pAdd(p,1);
  }
  const venc=per.filter(x=>x.due<T&&x.saldo>0),hoyP=per.find(x=>x.due===T&&x.saldo>0),prox=per.find(x=>x.due>T&&x.saldo>0);
  let estado='alDia';
  if(venc.length)estado='vencido';else if(hoyP)estado='hoy';else if(prox&&prox.due-T<=aviso)estado='porVencer';
  const deuda=r2(venc.reduce((a,x)=>a+x.saldo,0)+(hoyP?hoyP.saldo:0));
  return {estado,deuda,dias:venc.length?T-venc[0].due:0,per,ref:venc[0]||hoyP||prox||null,prox,T};
}
function esperado(p){
  let s=0;
  for(const t of S.tenants){
    if(!t.fecha_ingreso||p<t.fecha_ingreso.slice(0,7))continue;
    if(!t.activo&&t.fecha_salida&&p>t.fecha_salida.slice(0,7))continue;
    s+=+t.monto||0;
  }
  return r2(s);
}
const cobrado=p=>r2(S.pagos.filter(x=>x.periodo===p).reduce((a,x)=>a+(+x.monto||0),0));
function statusText(st){
  if(!st)return EST.libre.label;
  if(st.estado==='vencido')return 'Vencido · '+st.dias+' d';
  if(st.estado==='hoy')return 'Vence hoy';
  if(st.estado==='porVencer')return 'Vence '+fmtD(st.ref.due);
  return 'Al día';
}
const pill=(estado,text)=>`<span class="pill s-${estado}"><i aria-hidden="true">${EST[estado].icon}</i>${esc(text||EST[estado].label)}</span>`;

/* ============================================================
   WHATSAPP
   ============================================================ */
function fillTpl(tpl,v){return String(tpl||'').replace(/\{(\w+)\}/g,(m,k)=>Object.prototype.hasOwnProperty.call(v,k)?v[k]:m)}
function msgFor(t,kind,pago){
  const c=cfg(),st=ST.get(t.id),ref=st&&st.ref;
  const v={nombre:(t.nombre||'').trim().split(/\s+/)[0]||'',habitacion:roomNo(t.habitacion),monto:fmtN(t.monto),
    deuda:fmtN(st?st.deuda:0),dias:String(st?st.dias:0),fecha:ref?fmtFull(ref.due):'',mes:pago?pLabel(pago.periodo):(ref?pLabel(ref.p):pLabel(curP())),
    yape:c.yape||'',inmueble:c.nombre||'',pago:pago?fmtN(pago.monto):''};
  const tpl=kind==='vencido'?c.t_vencido:kind==='gracias'?c.t_gracias:c.t_recordatorio;
  return fillTpl(tpl||DEFAULTS[kind==='vencido'?'t_vencido':kind==='gracias'?'t_gracias':'t_recordatorio'],v);
}
function waUrl(t,kind,pago){const ph=waPhone(t.celular);return ph?'https://wa.me/'+ph+'?text='+encodeURIComponent(msgFor(t,kind,pago)):''}
const autoKind=t=>{const st=ST.get(t.id);return st&&st.estado==='vencido'?'vencido':'recordatorio'};
const ICON_WA='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.6a2.8 2.8 0 0 0 1.8-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.2-.2-.5-.3z"/></svg>';
const ICON_PAY='<svg viewBox="0 0 24 24" stroke-width="1.9" aria-hidden="true"><rect x="2" y="6" width="20" height="13" rx="2"/><circle cx="12" cy="12.5" r="2.5"/></svg>';
function waAct(t,kind){
  const u=waUrl(t,kind||autoKind(t));
  return u?`<a class="act wa" href="${esc(u)}" target="_blank" rel="noopener" aria-label="Enviar WhatsApp a ${esc(t.nombre)}">${ICON_WA}</a>`
          :`<span class="act wa off" title="Falta el celular">${ICON_WA}</span>`;
}
function waBtn(t,kind,label,pago){
  const u=waUrl(t,kind,pago);
  return u?`<a class="btn wa" href="${esc(u)}" target="_blank" rel="noopener">${ICON_WA.replace('<svg','<svg width="18" height="18" fill="#fff"')} ${esc(label)}</a>`
          :`<span class="btn off">${esc(label)} (falta celular)</span>`;
}

/* ============================================================
   AVISOS Y ESCRITURAS
   ============================================================ */
let toastT;
function toast(msg){clearTimeout(toastT);let el=document.querySelector('.toast');if(!el){el=document.createElement('div');el.className='toast';el.setAttribute('role','status');document.body.appendChild(el)}el.textContent=msg;toastT=setTimeout(()=>el.remove(),3400)}
function errMsg(e){
  const c=e&&e.code,m=String(e&&e.message||'');
  if(c==='23505')return 'Esa habitación ya tiene un inquilino activo.';
  if(c==='23503')return 'No se puede borrar porque tiene pagos registrados.';
  if(c==='42501'||/row-level security/i.test(m))return 'Tu usuario no tiene permiso. Vuelve a entrar.';
  if(/JWT|token/i.test(m))return 'Tu sesión venció. Vuelve a entrar.';
  if(/fetch|network|Failed/i.test(m))return 'Sin conexión. Revisa tu internet e inténtalo otra vez.';
  return 'No se pudo guardar: '+m;
}
// Ejecuta una consulta de Supabase; devuelve los datos o null si falló (y avisa)
async function run(promise,ok){
  let res;
  try{res=await promise}catch(e){toast(errMsg(e));return null}
  if(res.error){toast(errMsg(res.error));return null}
  if(ok)toast(ok);
  return res.data==null?true:res.data;
}
// Llama una función del servidor y devuelve {error} o los datos
async function fn(name,body){
  try{
    const {data,error}=await sb.functions.invoke(name,{body});
    if(error){let j=null;try{j=await error.context.json()}catch(e){}return {error:(j&&j.error)||'red'}}
    return data||{};
  }catch(e){return {error:'red'}}
}
const PK={habitaciones:'numero',inquilinos:'id',pagos:'id',notas:'id'};
const KEY={habitaciones:'rooms',inquilinos:'tenants',pagos:'pagos',notas:'notas'};
function upsertLocal(table,row){
  if(!row)return;
  if(table==='config'){S.config=row;return}
  const k=KEY[table],pk=PK[table],arr=S[k],i=arr.findIndex(x=>x[pk]===row[pk]);
  if(i>=0)arr[i]=row;else arr.push(row);
  if(table==='habitaciones')arr.sort((a,b)=>a.numero-b.numero);
}
function removeLocal(table,pkVal){const k=KEY[table],pk=PK[table];S[k]=S[k].filter(x=>x[pk]!==pkVal)}

/* ============================================================
   CARGA Y TIEMPO REAL
   ============================================================ */
async function fetchAll(table,order){
  const out=[];
  for(let from=0;;from+=1000){
    const {data,error}=await sb.from(table).select('*').order(order).range(from,from+999);
    if(error)throw error;
    out.push(...data);if(data.length<1000)break;
  }
  return out;
}
async function cargar(){
  const [c,h,i,p,n,u]=await Promise.all([
    sb.from('config').select('*').eq('id',1).maybeSingle().then(r=>{if(r.error)throw r.error;return r.data}),
    fetchAll('habitaciones','numero'),fetchAll('inquilinos','creado'),fetchAll('pagos','creado'),fetchAll('notas','creado'),fetchAll('perfiles','creado')]);
  S.config=c;S.rooms=h;S.tenants=i;S.pagos=p;S.notas=n;S.perfiles=u;S.loaded=true;
}
let canal=null,renderT=null;
function schedule(){clearTimeout(renderT);renderT=setTimeout(()=>{if(S.view==='ajustes'&&S.shown==='ajustes')return;render()},60)}
function escuchar(){
  if(canal)sb.removeChannel(canal);
  canal=sb.channel('cambios');
  for(const table of ['config','habitaciones','inquilinos','pagos','notas']){
    canal.on('postgres_changes',{event:'*',schema:'public',table},pl=>{
      if(pl.eventType==='DELETE'){if(table!=='config'&&pl.old)removeLocal(table,pl.old[PK[table]])}
      else upsertLocal(table,pl.new);
      schedule();
    });
  }
  canal.subscribe();
}
let ocultoDesde=0;
document.addEventListener('visibilitychange',async()=>{
  if(document.visibilityState==='hidden'){ocultoDesde=Date.now();return}
  HOY=hoyStr();
  if(S.yo&&ocultoDesde&&Date.now()-ocultoDesde>60000){try{await cargar();schedule()}catch(e){}}
});

/* ============================================================
   ACCESO: solo la pantalla de bloqueo
   ============================================================ */
// El código abre una cuenta compartida en Supabase; sin ella las reglas del
// servidor no devuelven ningún dato. Se pide una vez por dispositivo.
const EMAIL_CASA='casa@'+DOMINIO;
function mostrarBloqueo(){
  $('app').hidden=true;$('lock').hidden=false;
  $('k-pin').value='';$('k-err').textContent='';$('k-pin').disabled=false;
  setTimeout(()=>$('k-pin').focus(),50);
}
async function probarCodigo(){
  const code=$('k-pin').value.trim();
  if(!/^\d{6}$/.test(code)){$('k-err').textContent='El código tiene 6 números.';return}
  $('k-pin').disabled=true;$('k-err').textContent='Verificando…';
  const {error}=await sb.auth.signInWithPassword({email:EMAIL_CASA,password:claveDe(code)});
  $('k-pin').disabled=false;
  if(error){
    $('k-pin').value='';$('k-pin').focus();
    $('k-err').textContent=/rate|many/i.test(error.message)?'Demasiados intentos. Espera unos minutos.':/fetch|network/i.test(error.message)?'Sin conexión. Revisa tu internet.':'Código incorrecto.';
    return;
  }
  await iniciar();
}
$('lock-form').addEventListener('submit',e=>{e.preventDefault();probarCodigo()});
$('k-pin').addEventListener('input',e=>{e.target.value=e.target.value.replace(/\D/g,'');$('k-err').textContent='';if(e.target.value.length===6)probarCodigo()});

async function iniciar(){
  const {data:{session}}=await sb.auth.getSession();
  if(!session){mostrarBloqueo();return}
  const {data:yo}=await sb.from('perfiles').select('*').eq('id',session.user.id).maybeSingle();
  if(!yo||!yo.activo){await sb.auth.signOut();mostrarBloqueo();return}
  S.yo=yo;
  $('lock').hidden=true;$('app').hidden=false;
  const v=lsGet('hc-view');if(v&&v!=='ajustes')S.view=v;
  render();
  try{await cargar()}catch(e){toast(errMsg(e))}
  escuchar();render();
}
async function bloquear(){
  if(canal){sb.removeChannel(canal);canal=null}
  S.yo=null;S.loaded=false;closeSheet();
  await sb.auth.signOut();
  mostrarBloqueo();
}
sb.auth.onAuthStateChange(ev=>{if(ev==='SIGNED_OUT'&&S.yo){S.yo=null;mostrarBloqueo()}});

/* ============================================================
   VISTAS
   ============================================================ */
const V={};
function render(){
  const c=cfg();
  $('h-title').textContent=c.nombre||'Habitaciones y Cobros';
  const occ=S.tenants.filter(t=>t.activo).length;
  $('h-sub').textContent=!S.loaded?'Cargando datos…':`${S.rooms.length} habitaciones · ${occ} ocupadas`;
  document.querySelectorAll('.nav button').forEach(b=>{if(b.dataset.view===S.view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
  const el=$('view');
  const ae=document.activeElement,aeId=ae&&el.contains(ae)?ae.id:null,aeSel=aeId&&ae.selectionStart!=null?ae.selectionStart:null;
  if(!S.loaded){el.innerHTML=`<div class="empty">Cargando habitaciones, inquilinos y pagos…</div>`;return}
  recompute();
  el.innerHTML=(V[S.view]||V.inicio)();
  if(aeId){const n=$(aeId);if(n){n.focus({preventScroll:true});if(aeSel!=null&&n.setSelectionRange)try{n.setSelectionRange(aeSel,aeSel)}catch(e){}}}
  S.shown=S.view;
}

V.inicio=function(){
  const p=curP(),esp=esperado(p),cob=cobrado(p),pct=esp?Math.min(100,Math.round(cob/esp*100)):0;
  const cnt={vencido:0,hoy:0,porVencer:0,alDia:0,libre:0};let deuda=0;
  for(const r of S.rooms){const t=ROOMT.get(r.numero);if(!t){cnt.libre++;continue}const st=ST.get(t.id);cnt[st.estado]++;deuda+=st.deuda}
  const att=S.tenants.filter(t=>ST.has(t.id)&&ST.get(t.id).estado!=='alDia')
    .sort((a,b)=>{const x=ST.get(a.id),y=ST.get(b.id);return EST[x.estado].ord-EST[y.estado].ord||(x.estado==='vencido'?y.dias-x.dias:x.ref.due-y.ref.due)});
  return `<div class="stack">
  <section class="panel kpi" aria-label="Resumen del mes">
    <div class="eyebrow">Cobrado en ${esc(pLabel(p))}</div>
    <div class="big">${money(cob)} <small>de ${money(esp)}</small></div>
    <div class="bar" role="img" aria-label="${pct}% cobrado"><span style="width:${pct}%"></span></div>
    <div class="muted" style="font-size:13px">${pct}% cobrado${deuda>0?` · Deuda vencida total: <b style="color:var(--bad)">${money(deuda)}</b>`:''}</div>
    <div class="counts">${['vencido','hoy','porVencer','alDia','libre'].map(k=>`<button class="count s-${k}" data-act="view" data-view="cuartos"><b>${cnt[k]}</b><span>${EST[k].icon} ${EST[k].label}</span></button>`).join('')}</div>
  </section>
  <div class="row"><button class="btn primary" data-act="pago">+ Registrar pago</button><button class="btn" data-act="tenantForm">+ Nuevo inquilino</button></div>
  <div class="sec-h"><h2>Necesitan atención</h2><span class="muted" style="font-size:13px">${att.length}</span></div>
  ${att.length?`<div class="list">${att.map(itemRow).join('')}</div>`:`<div class="empty">${S.tenants.some(t=>t.activo)?'Todos están al día. No hay pagos por vencer en los próximos '+cfg().dias_aviso+' días.':'Todavía no hay inquilinos. Toca “Nuevo inquilino” para registrar el primero.'}</div>`}
  <section class="panel stack"><div class="sec-h" style="margin:0"><h2>Cobrado por mes</h2><span class="muted" style="font-size:12px">por mes que cubre el pago</span></div>${chart()}</section>
  </div>`;
};
function itemRow(t){
  const st=ST.get(t.id);
  let sub=pill(st.estado,statusText(st));
  sub+=st.deuda>0?`<span class="num">Debe ${money(st.deuda)}</span>`:st.ref?`<span class="num">${money(st.ref.saldo)} · ${fmtD(st.ref.due)}</span>`:'';
  return `<div class="item"><span class="minitag">${roomNo(t.habitacion)}</span>
  <button class="main" data-act="tenant" data-id="${esc(t.id)}"><div class="name">${esc(t.nombre)}</div><div class="sub">${sub}</div></button>
  ${waAct(t)}<button class="act pay" data-act="pago" data-id="${esc(t.id)}" aria-label="Registrar pago de ${esc(t.nombre)}">${ICON_PAY}</button></div>`;
}
function nice(m){if(m<=0)return 100;const e=Math.pow(10,Math.floor(Math.log10(m/4)));for(const f of [1,2,2.5,5,10]){if(f*e*4>=m)return f*e*4}return 10*e*4}
function chart(){
  const ps=[];for(let i=5;i>=0;i--)ps.push(pAdd(curP(),-i));
  const vals=ps.map(cobrado),esp=ps.map(esperado),top=nice(Math.max(...vals,1));
  const ticks=[0,1,2,3,4].map(i=>top/4*i);
  return `<div class="chart">
   <div class="yax num">${ticks.map(v=>`<span>${v>=1000?(v/1000).toLocaleString('es-PE')+'k':v}</span>`).join('')}</div>
   <div class="plot">${ticks.slice(1).map(v=>`<div class="grid-l" style="bottom:${v/top*100}%"></div>`).join('')}
    <div class="cols">${ps.map((p,i)=>`<button class="col${i===5?' cur':''}" data-tip="${esc(pLabel(p))}: ${money(vals[i])} de ${money(esp[i])}" aria-label="${esc(pLabel(p))}: ${money(vals[i])} cobrado de ${money(esp[i])}"><span style="height:${vals[i]/top*100}%"></span>${i===5&&vals[i]>0?`<em class="num" style="bottom:calc(${vals[i]/top*100}% + 2px)">${money(vals[i])}</em>`:''}</button>`).join('')}</div>
   </div>
   <div class="xax">${ps.map(p=>`<span>${MES3[+p.slice(5)-1]}</span>`).join('')}</div>
  </div>`;
}

V.cuartos=function(){
  if(!S.rooms.length)return `<div class="empty">No hay habitaciones. Agrégalas en Ajustes.</div>`;
  return `<div class="stack">
  <div class="legend">${['vencido','hoy','porVencer','alDia','libre'].map(k=>pill(k)).join('')}</div>
  <div class="tags">${S.rooms.map(r=>{
    const t=ROOMT.get(r.numero),st=t&&ST.get(t.id),e=st?st.estado:'libre';
    const short=st?(e==='vencido'?st.dias+' d':e==='porVencer'?fmtD(st.ref.due):e==='hoy'?'Hoy':'Al día'):'Libre';
    return `<button class="tag s-${e}" data-act="room" data-id="${r.numero}" aria-label="Habitación ${pad(r.numero)}, ${esc(t?t.nombre:'libre')}, ${esc(statusText(st))}">
      <span class="tag-no">${pad(r.numero)}</span><span class="tag-name">${esc(t?(t.nombre||'').split(/\s+/)[0]:'S/ '+fmtN(r.precio))}</span>${pill(e,short)}${!t&&r.observaciones?'<span class="tag-obs" title="Tiene observaciones">🔧</span>':''}</button>`}).join('')}</div>
  ${obsList()}
  <p class="muted" style="font-size:13px;margin:0">Toca una habitación para ver al inquilino, su deuda, su bitácora y sus pagos. En las libres puedes anotar observaciones (pintura, focos, arreglos).</p></div>`;
};

function obsList(){
  const rs=S.rooms.filter(r=>!ROOMT.get(r.numero)&&r.observaciones);
  if(!rs.length)return '';
  return `<div class="sec-h"><h2>Pendientes en habitaciones libres</h2><span class="muted" style="font-size:13px">${rs.length}</span></div>
  <div class="list">${rs.map(r=>`<div class="item"><span class="minitag">${pad(r.numero)}</span><button class="main" data-act="room" data-id="${r.numero}"><div class="name">Habitación ${pad(r.numero)}</div><div class="sub obs-txt">${esc(r.observaciones)}</div></button></div>`).join('')}</div>`;
}

V.calendario=function(){
  const p=S.calP||curP(),[y,m]=p.split('-').map(Number),T=dn(HOY),aviso=+cfg().dias_aviso||0;
  const first=new Date(Date.UTC(y,m-1,1)).getUTCDay(),off=(first+6)%7,n=dim(y,m);
  const byDay={};
  for(const t of S.tenants){
    if(!t.activo||!t.fecha_ingreso||p<t.fecha_ingreso.slice(0,7))continue;
    const due=Math.max(dueOf(p,Math.min(31,Math.max(1,+t.dia_pago||1))),dn(t.fecha_ingreso));
    if(nstr(due).slice(0,7)!==p)continue;
    const saldo=Math.max(0,r2((+t.monto||0)-(PAID.get(t.id+'|'+p)||0)));
    const e=saldo<=0?'alDia':due<T?'vencido':due===T?'hoy':due-T<=aviso?'porVencer':'futuro';
    (byDay[nstr(due)]=byDay[nstr(due)]||[]).push({t,saldo,e,due});
  }
  const sel=S.calDay&&S.calDay.slice(0,7)===p?S.calDay:(HOY.slice(0,7)===p?HOY:null);
  let cells=['L','M','M','J','V','S','D'].map(d=>`<div class="dow">${d}</div>`).join('');
  for(let i=0;i<off;i++)cells+=`<div class="day blank" aria-hidden="true"></div>`;
  for(let d=1;d<=n;d++){
    const ds=p+'-'+pad(d),L=byDay[ds]||[];
    cells+=`<button class="day${ds===HOY?' today':''}${ds===sel?' sel':''}" data-act="calDay" data-day="${ds}" aria-label="${d} de ${MESES[m-1]}${L.length?', '+L.length+' vencimientos':''}"><b>${d}</b><span class="dots">${L.slice(0,4).map(x=>`<span class="dot s-${x.e==='futuro'?'libre':x.e}"></span>`).join('')}${L.length>4?`<small>+${L.length-4}</small>`:''}</span></button>`;
  }
  const L=sel?(byDay[sel]||[]):[];
  return `<div class="stack">
  <div class="calnav"><button class="iconbtn" data-act="calMove" data-d="-1" aria-label="Mes anterior">‹</button><h2>${esc(pLabel(p))}</h2><button class="iconbtn" data-act="calMove" data-d="1" aria-label="Mes siguiente">›</button></div>
  <div class="cal">${cells}</div>
  <div class="legend">${pill('vencido','Vencido')}${pill('hoy','Hoy')}${pill('porVencer','Por vencer')}${pill('alDia','Pagado')}${pill('libre','Más adelante')}</div>
  ${sel?`<h3>Vencimientos del ${fmtS(sel)}</h3>${L.length?`<div class="list">${L.map(x=>`<div class="item"><span class="minitag">${roomNo(x.t.habitacion)}</span><button class="main" data-act="tenant" data-id="${esc(x.t.id)}"><div class="name">${esc(x.t.nombre)}</div><div class="sub">${x.saldo>0?pill(x.e==='futuro'?'libre':x.e,'Pendiente '+money(x.saldo)):pill('alDia','Pagado')}</div></button>${x.saldo>0?waAct(x.t,x.e==='vencido'?'vencido':'recordatorio')+`<button class="act pay" data-act="pago" data-id="${esc(x.t.id)}" data-periodo="${p}" aria-label="Registrar pago">${ICON_PAY}</button>`:''}</div>`).join('')}</div>`:`<div class="empty">Nadie paga este día.</div>`}`:''}
  </div>`;
};

V.pagos=function(){
  const months=new Set(S.pagos.map(x=>x.periodo));months.add(curP());
  const opts=[...months].sort().reverse();
  const f=S.pagP||curP();
  const list=S.pagos.filter(x=>f==='todos'||x.periodo===f).sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||'')||(b.creado||'').localeCompare(a.creado||''));
  const tot=r2(list.reduce((a,x)=>a+(+x.monto||0),0));
  return `<div class="stack">
  <div class="toolbar"><select id="pg-mes" data-act="pagMes" aria-label="Mes que cubre"><option value="todos"${f==='todos'?' selected':''}>Todos los meses</option>${opts.map(o=>`<option value="${o}"${o===f?' selected':''}>${esc(pLabel(o))}</option>`).join('')}</select>
  <button class="btn primary" data-act="pago">+ Registrar pago</button><button class="btn" data-act="export">Exportar a Excel</button></div>
  ${list.length?`<div class="ptable">${list.map(x=>{const t=tenantById(x.inquilino_id);return `<button class="prow" data-act="pagoVer" data-id="${esc(x.id)}"><span class="minitag">${roomNo(x.habitacion)}</span><span class="who"><b>${esc(t?t.nombre:'Inquilino eliminado')}</b><small>${fmtS(x.fecha)} · ${esc(x.metodo||'')} · ${esc(pLabel(x.periodo))}</small></span><span class="amt num">${money(x.monto)}</span></button>`}).join('')}
  <div class="total"><span>Total (${list.length} pagos)</span><span class="num">${money(tot)}</span></div></div>`
  :`<div class="empty">No hay pagos registrados${f==='todos'?'':' para '+esc(pLabel(f))}. Toca “Registrar pago” para anotar el primero.</div>`}
  </div>`;
};

V.inquilinos=function(){
  const q=S.q.trim().toLowerCase();
  const list=S.tenants.filter(t=>(S.showRet?!t.activo:t.activo)&&(!q||[t.nombre,t.dni,t.celular,roomNo(t.habitacion)].join(' ').toLowerCase().includes(q)))
    .sort((a,b)=>S.showRet?(b.fecha_salida||'').localeCompare(a.fecha_salida||''):a.habitacion-b.habitacion);
  return `<div class="stack">
  <div class="toolbar"><input id="iq-q" type="search" placeholder="Buscar por nombre, DNI, celular o habitación" value="${esc(S.q)}" data-act="buscar" aria-label="Buscar inquilino"><button class="btn primary" data-act="tenantForm">+ Nuevo inquilino</button></div>
  <label class="check"><input type="checkbox" id="iq-ret" data-act="toggleRet"${S.showRet?' checked':''}> Ver ex inquilinos</label>
  ${list.length?`<div class="list">${list.map(t=>{const st=ST.get(t.id);const nn=S.notas.filter(x=>x.inquilino_id===t.id).length;return `<div class="item"><span class="minitag">${roomNo(t.habitacion)}</span>
   <button class="main" data-act="tenant" data-id="${esc(t.id)}"><div class="name">${esc(t.nombre)}</div><div class="sub">${st?pill(st.estado,statusText(st)):`<span>Salió el ${fmtS(t.fecha_salida)}</span>`}<span class="num">${money(t.monto)} · día ${esc(t.dia_pago)}</span>${nn?`<span>${nn} nota${nn>1?'s':''}</span>`:''}</div></button>
   ${st?waAct(t):''}</div>`}).join('')}</div>`
  :`<div class="empty">${S.showRet?'No hay ex inquilinos.':q?'Ningún inquilino coincide con la búsqueda.':'Todavía no hay inquilinos registrados.'}</div>`}
  </div>`;
};

V.ajustes=function(){
  const c=cfg();
  return `<div class="stack">
  <section class="panel stack"><h2>Este dispositivo</h2>
   <p class="muted" style="margin:0;font-size:13px">Este celular o computadora ya está desbloqueado. Bloquéalo si lo vas a prestar o si alguien más lo usa: para volver a entrar se pedirá el código.</p>
   <div class="row"><button class="btn danger" data-act="bloquear">Bloquear este dispositivo</button></div>
  </section>
  <form class="panel stack" data-form="config"><h2>General</h2>
   <div class="field"><label for="c-nombre">Nombre del inmueble</label><input id="c-nombre" value="${esc(c.nombre)}" placeholder="Ej. Casa Los Olivos"></div>
   <div class="grid2 adapt"><div class="field"><label for="c-yape">Número de Yape</label><input id="c-yape" value="${esc(c.yape)}" inputmode="tel" placeholder="9XX XXX XXX"></div>
   <div class="field"><label for="c-aviso">Avisar con (días de anticipación)</label><input id="c-aviso" type="number" min="0" max="31" value="${esc(c.dias_aviso)}" inputmode="numeric"></div></div>
   <div class="field"><label for="c-precio">Precio normal de una habitación (S/)</label><input id="c-precio" type="number" min="0" step="0.01" value="${esc(c.precio_base)}" inputmode="decimal"><span class="hint">Se usa como precio de las habitaciones nuevas.</span></div>
   <h2 style="margin-top:6px">Mensajes de WhatsApp</h2>
   <p class="placeholders muted" style="margin:0;font-size:13px;line-height:1.9">Palabras que se reemplazan solas: <code>{nombre}</code> <code>{habitacion}</code> <code>{monto}</code> <code>{deuda}</code> <code>{fecha}</code> <code>{dias}</code> <code>{mes}</code> <code>{yape}</code> <code>{inmueble}</code> <code>{pago}</code></p>
   <div class="field"><label for="c-trec">Recordatorio (antes de vencer)</label><textarea id="c-trec">${esc(c.t_recordatorio||DEFAULTS.t_recordatorio)}</textarea></div>
   <div class="field"><label for="c-tven">Pago vencido</label><textarea id="c-tven">${esc(c.t_vencido||DEFAULTS.t_vencido)}</textarea></div>
   <div class="field"><label for="c-tgra">Confirmación de pago</label><textarea id="c-tgra">${esc(c.t_gracias||DEFAULTS.t_gracias)}</textarea></div>
   <button class="btn primary">Guardar ajustes</button>
  </form>
  <form class="panel stack" data-form="precios"><h2>Precio por habitación</h2>
   <p class="muted" style="margin:0;font-size:13px">El precio se sugiere al registrar un inquilino nuevo. Para cambiar lo que paga un inquilino actual, edita su monto en su ficha.</p>
   <div class="grid2">${S.rooms.map(r=>`<div class="field"><label for="r-${r.numero}">Habitación ${pad(r.numero)}</label><input id="r-${r.numero}" data-room="${r.numero}" type="number" min="0" step="0.01" value="${esc(r.precio)}" inputmode="decimal"></div>`).join('')}</div>
   <div class="row"><button class="btn primary">Guardar precios</button><button type="button" class="btn" data-act="addRoom">+ Agregar habitación</button></div>
  </form>
  </div>`;
};
/* ============================================================
   HOJAS (VENTANAS)
   ============================================================ */
function openSheet(html,focus){
  $('sheet-root').innerHTML=`<div class="scrim" data-act="closeBg"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  if(focus){const f=document.querySelector('.sheet '+focus);if(f)f.focus({preventScroll:true})}
}
function closeSheet(){$('sheet-root').innerHTML=''}
const sheetHead=(title,sub)=>`<div class="sheet-h"><div><h2>${title}</h2>${sub?`<div class="muted" style="font-size:13px;margin-top:2px">${sub}</div>`:''}</div><button class="iconbtn" data-act="close" aria-label="Cerrar">✕</button></div>`;
let CONFIRM=null;
function confirmSheet(title,text,label,fnc,extra){
  CONFIRM=fnc;
  openSheet(sheetHead(esc(title))+`<p style="margin:0 0 16px">${text}</p>${extra||''}<div class="row"><button class="btn" data-act="close">Cancelar</button><button class="btn danger" data-act="confirmYes">${esc(label)}</button></div>`);
}

function roomSheet(num){
  const r=roomByNum(num);if(!r)return;
  const t=ROOMT.get(r.numero);
  if(t)return tenantSheet(t.id);
  openSheet(sheetHead('Habitación '+pad(r.numero),'Libre · '+money(r.precio)+' al mes')+
   `<form class="stack" data-form="obs" data-id="${r.numero}" style="margin-bottom:16px">
    <div class="field"><label for="o-texto">Observaciones</label><textarea id="o-texto" placeholder="Ej.: falta pintar, cambiar focos, arreglar la chapa…">${esc(r.observaciones)}</textarea><span class="hint">Arreglos o pendientes antes de alquilarla.</span></div>
    <div class="row"><button class="btn">Guardar observaciones</button></div></form>
   <div class="row"><button class="btn primary" data-act="tenantForm" data-room="${r.numero}">Registrar inquilino aquí</button></div>`);
}
function tenantSheet(tid,keepScroll){
  const t=tenantById(tid);if(!t)return closeSheet();
  const prevScroll=keepScroll&&document.querySelector('.sheet')?document.querySelector('.sheet').scrollTop:0;
  recompute();
  const st=ST.get(t.id),pagos=S.pagos.filter(x=>x.inquilino_id===t.id).sort((a,b)=>b.periodo.localeCompare(a.periodo)||(b.fecha||'').localeCompare(a.fecha||''));
  const notas=S.notas.filter(x=>x.inquilino_id===t.id).sort((a,b)=>b.fecha.localeCompare(a.fecha)||(b.creado||'').localeCompare(a.creado||''));
  const lastPago=pagos[0];
  let body='';
  if(st){
    body+=`<div class="debt s-${st.estado}">${pill(st.estado,statusText(st))}
      <div style="margin-top:8px">${st.deuda>0?`Debe <b class="num">${money(st.deuda)}</b>`:st.ref?`Próximo pago: <b class="num">${money(st.ref.saldo)}</b> el ${fmtFull(st.ref.due)}`:'Pagado por adelantado.'}</div></div>`;
    body+=`<div class="row" style="margin-top:12px"><button class="btn primary" data-act="pago" data-id="${esc(t.id)}">Registrar pago</button></div>`;
    body+=`<div class="stack" style="margin-top:12px;gap:8px"><div class="eyebrow">Enviar por WhatsApp</div><div class="row">${waBtn(t,'recordatorio','Recordatorio')}${st.deuda>0?waBtn(t,'vencido','Cobro de deuda'):''}${lastPago?waBtn(t,'gracias','Confirmar último pago',lastPago):''}</div></div>`;
  }
  body+=`<dl class="kv" style="margin:16px 0">
   <dt>Celular</dt><dd>${esc(t.celular||'—')}</dd><dt>DNI</dt><dd>${esc(t.dni||'—')}</dd>
   <dt>Monto mensual</dt><dd class="num">${money(t.monto)}</dd><dt>Día de pago</dt><dd>${esc(t.dia_pago)} de cada mes</dd>
   <dt>Ingreso</dt><dd>${fmtS(t.fecha_ingreso)}</dd>${!t.activo?`<dt>Salida</dt><dd>${fmtS(t.fecha_salida)}</dd>`:''}
   <dt>Garantía</dt><dd class="num">${+t.garantia?money(t.garantia):'—'}</dd>${t.notas?`<dt>Datos extra</dt><dd style="font-weight:400">${esc(t.notas)}</dd>`:''}</dl>`;
  // Bitácora
  body+=`<div class="sec-h" style="margin-bottom:8px"><h3>Bitácora</h3><span class="muted" style="font-size:13px">${notas.length}</span></div>
   <form class="nota-form" data-form="nota" data-id="${esc(t.id)}" style="margin-bottom:10px">
    <input id="n-fecha" type="date" value="${HOY}" aria-label="Fecha de la nota">
    <textarea id="n-texto" placeholder="Ej. Se le cambió la cama · Dejó corriendo el agua" aria-label="Nota" maxlength="2000"></textarea>
    <button class="btn">Agregar nota</button></form>
   ${notas.length?`<ul class="notas">${notas.map(n=>`<li><span class="meta"><b>${fmtS(n.fecha)}</b> · ${esc(perfilNombre(n.autor))}</span><p>${esc(n.texto)}</p><button class="x" data-act="delNota" data-id="${esc(n.id)}" data-t="${esc(t.id)}" aria-label="Borrar nota">✕</button></li>`).join('')}</ul>
   ${notas.length>1?`<div class="row" style="margin-top:8px"><button class="btn small danger" data-act="delNotas" data-id="${esc(t.id)}">Borrar todas las notas</button></div>`:''}`:`<div class="empty">Sin notas. Anota aquí cambios, incidentes o acuerdos con el inquilino.</div>`}`;
  // Pagos
  body+=`<div class="sec-h" style="margin:18px 0 8px"><h3>Pagos</h3><span class="muted" style="font-size:13px">${pagos.length}</span></div>`;
  body+=pagos.length?`<div class="hist">${pagos.map(x=>`<button data-act="pagoVer" data-id="${esc(x.id)}"><span class="m">${esc(pLabel(x.periodo))}</span><span class="a num">${money(x.monto)}</span><small>${fmtS(x.fecha)} · ${esc(x.metodo||'')}</small><small>${x.comprobante?'con comprobante':''}</small></button>`).join('')}</div>`:`<div class="empty">Sin pagos registrados.</div>`;
  body+=`<div class="row" style="margin-top:16px"><button class="btn" data-act="tenantForm" data-id="${esc(t.id)}">Editar datos</button>${t.activo?`<button class="btn danger" data-act="retirar" data-id="${esc(t.id)}">Registrar salida</button>`:''}${!pagos.length?`<button class="btn danger" data-act="delTenant" data-id="${esc(t.id)}">Eliminar registro</button>`:''}</div>`;
  openSheet(sheetHead(esc(t.nombre),t.activo?'Habitación '+roomNo(t.habitacion):'Ex inquilino · estuvo en la habitación '+roomNo(t.habitacion))+body);
  if(prevScroll)document.querySelector('.sheet').scrollTop=prevScroll;
}

function tenantForm(tid,roomNum){
  const t=tid?tenantById(tid):null,c=cfg();
  recompute();
  const free=S.rooms.filter(r=>!ROOMT.has(r.numero)||(t&&r.numero===t.habitacion));
  if(!free.length&&!t){openSheet(sheetHead('No hay habitaciones libres')+`<p style="margin:0">Registra primero la salida del inquilino anterior para liberar una habitación.</p>`);return}
  const room=t?t.habitacion:(+roomNum||free[0].numero),r=roomByNum(room);
  const ing=t?t.fecha_ingreso:HOY;
  const opciones=t&&!t.activo?[roomByNum(t.habitacion)].filter(Boolean):free;
  openSheet(sheetHead(t?'Editar inquilino':'Nuevo inquilino')+`<form class="stack" data-form="tenant" data-id="${esc(tid||'')}">
   <div class="field"><label for="t-dni">DNI</label><div class="inline"><input id="t-dni" inputmode="numeric" maxlength="8" value="${esc(t?t.dni:'')}" placeholder="8 números"><button type="button" class="btn" id="t-dni-btn" data-act="buscarDni">Buscar</button></div><span class="hint">Escribe el DNI y toca Buscar para llenar el nombre.</span></div>
   <div class="field"><label for="t-nombre">Nombre completo</label><input id="t-nombre" required value="${esc(t?t.nombre:'')}" autocomplete="off"></div>
   <div class="field"><label for="t-cel">Celular</label><input id="t-cel" inputmode="tel" value="${esc(t?t.celular:'')}" placeholder="9XX XXX XXX"></div>
   <div class="grid2"><div class="field"><label for="t-room">Habitación</label><select id="t-room" ${t&&!t.activo?'disabled':''}>${opciones.map(x=>`<option value="${x.numero}"${x.numero===room?' selected':''}>Habitación ${pad(x.numero)} · ${money(x.precio)}</option>`).join('')}</select></div>
   <div class="field"><label for="t-monto">Monto mensual (S/)</label><input id="t-monto" type="number" min="0" step="0.01" required inputmode="decimal" value="${esc(t?t.monto:(r?r.precio:c.precio_base))}"></div></div>
   <div class="grid2"><div class="field"><label for="t-ing">Fecha de ingreso</label><input id="t-ing" type="date" required value="${esc(ing)}"></div>
   <div class="field"><label for="t-dia">Día de pago</label><input id="t-dia" type="number" min="1" max="31" required inputmode="numeric" value="${esc(t?t.dia_pago:+ing.slice(8))}"></div></div>
   <div class="field"><label for="t-gar">Garantía (S/)</label><input id="t-gar" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(t&&+t.garantia?t.garantia:'')}" placeholder="0"></div>
   ${t?'':`<div class="field"><label for="t-met">Pago del primer mes</label><select id="t-met">${METODOS.map(m=>`<option>${m}</option>`).join('')}</select><span class="hint">El primer mes se registra como pagado, por el monto mensual y con la fecha de ingreso.</span></div>`}
   <div class="field"><label for="t-notas">Datos extra</label><textarea id="t-notas" placeholder="Contacto de emergencia, referencias…">${esc(t?t.notas:'')}</textarea><span class="hint">Para incidentes con fecha usa la bitácora de su ficha.</span></div>
   <button class="btn primary" id="t-save">${t?'Guardar cambios':'Registrar inquilino'}</button></form>`,t?null:'#t-dni');
}

function periodOptions(tid,want){
  const t=tenantById(tid),st=t&&ST.get(t.id);if(!st)return {html:'',first:null};
  const opts=st.per.filter(x=>x.saldo>0).map(x=>({p:x.p,saldo:x.saldo,txt:`${pLabel(x.p)} · debe ${money(x.saldo)}${x.due<st.T?' (vencido)':''}`}));
  const last=st.per.length?st.per[st.per.length-1].p:t.fecha_ingreso.slice(0,7);
  for(let i=1;i<=3;i++){const p=pAdd(last,i);opts.push({p,saldo:+t.monto||0,txt:`${pLabel(p)} · adelantado`})}
  const paid=st.per.filter(x=>x.saldo<=0).reverse().slice(0,3).map(x=>({p:x.p,saldo:0,txt:`${pLabel(x.p)} · ya pagado`}));
  const all=[...opts,...paid];
  const sel=all.find(o=>o.p===want)||all[0];
  return {html:all.map(o=>`<option value="${o.p}" data-saldo="${o.saldo}"${o===sel?' selected':''}>${esc(o.txt)}</option>`).join(''),first:sel};
}
function pagoForm(tid,periodo){
  recompute();
  const act=S.tenants.filter(t=>t.activo).sort((a,b)=>a.habitacion-b.habitacion);
  if(!act.length){openSheet(sheetHead('Registrar pago')+`<p style="margin:0">Primero registra un inquilino.</p>`);return}
  const cur=tid&&tenantById(tid)&&tenantById(tid).activo?tid:act[0].id;
  const po=periodOptions(cur,periodo);
  openSheet(sheetHead('Registrar pago')+`<form class="stack" data-form="pago">
   <div class="field"><label for="p-inq">Inquilino</label><select id="p-inq" data-act="pagoInq">${act.map(t=>`<option value="${esc(t.id)}"${t.id===cur?' selected':''}>Hab. ${roomNo(t.habitacion)} · ${esc(t.nombre)}</option>`).join('')}</select></div>
   <div class="field"><label for="p-per">Mes que paga</label><select id="p-per" data-act="pagoPer">${po.html}</select></div>
   <div class="grid2"><div class="field"><label for="p-monto">Monto (S/)</label><input id="p-monto" type="number" min="0.01" step="0.01" required inputmode="decimal" value="${po.first?po.first.saldo||'':''}"></div>
   <div class="field"><label for="p-fecha">Fecha de pago</label><input id="p-fecha" type="date" required value="${HOY}"></div></div>
   <div class="field"><label for="p-met">Método</label><select id="p-met">${METODOS.map(m=>`<option>${m}</option>`).join('')}</select></div>
   <div class="field"><label for="p-nota">Nota</label><input id="p-nota" placeholder="Opcional"></div>
   <div class="field"><label for="p-foto">Foto del comprobante</label><input id="p-foto" type="file" accept="image/*"><span class="hint">Opcional. Por ejemplo, la captura del Yape.</span></div>
   <button class="btn primary" id="p-save">Guardar pago</button></form>`);
}
function pagoSheet(id){
  const x=S.pagos.find(p=>p.id===id);if(!x)return;
  const t=tenantById(x.inquilino_id);
  openSheet(sheetHead(money(x.monto),esc((t?t.nombre:'Inquilino eliminado')+' · Habitación '+roomNo(x.habitacion)))+
   `<dl class="kv" style="margin:0 0 14px"><dt>Mes que cubre</dt><dd style="text-transform:capitalize">${esc(pLabel(x.periodo))}</dd><dt>Fecha</dt><dd>${fmtS(x.fecha)}</dd><dt>Método</dt><dd>${esc(x.metodo||'—')}</dd>${x.nota?`<dt>Nota</dt><dd style="font-weight:400">${esc(x.nota)}</dd>`:''}<dt>Registrado por</dt><dd>${esc(perfilNombre(x.registrado_por))}</dd></dl>
   ${x.comprobante?`<div id="pv-img" class="muted" style="margin-bottom:14px">Cargando comprobante…</div>`:''}
   <div class="row">${t&&t.activo?waBtn(t,'gracias','Enviar confirmación',x):''}<button class="btn danger" data-act="delPago" data-id="${esc(x.id)}">Eliminar pago</button></div>`);
  if(x.comprobante)sb.storage.from('comprobantes').createSignedUrl(x.comprobante,3600).then(({data,error})=>{
    const el=$('pv-img');if(!el)return;
    if(error||!data){el.textContent='No se pudo cargar el comprobante.';return}
    el.innerHTML=`<a href="${esc(data.signedUrl)}" target="_blank" rel="noopener"><img class="thumb" src="${esc(data.signedUrl)}" alt="Comprobante del pago"></a>`;
  });
}


/* ============================================================
   IMÁGENES
   ============================================================ */
async function comprimir(file){
  try{
    const bmp=await createImageBitmap(file),s=Math.min(1,1400/Math.max(bmp.width,bmp.height));
    const c=document.createElement('canvas');c.width=Math.round(bmp.width*s);c.height=Math.round(bmp.height*s);
    c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
    const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.75));
    return blob||file;
  }catch(e){return file}
}
const uuid=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);

/* ============================================================
   FORMULARIOS
   ============================================================ */
const val=id=>{const e=$(id);return e?e.value.trim():''};
const FORMS={
  async config(){
    const d={nombre:val('c-nombre'),yape:val('c-yape'),dias_aviso:Math.min(31,Math.max(0,parseInt(val('c-aviso'))||0)),precio_base:r2(val('c-precio')),
      t_recordatorio:val('c-trec')||DEFAULTS.t_recordatorio,t_vencido:val('c-tven')||DEFAULTS.t_vencido,t_gracias:val('c-tgra')||DEFAULTS.t_gracias};
    const row=await run(sb.from('config').update(d).eq('id',1).select().single(),'Ajustes guardados');
    if(row&&row!==true){upsertLocal('config',row);render()}
  },
  async precios(){
    const ch=[...document.querySelectorAll('[data-room]')].map(i=>({n:+i.dataset.room,p:r2(i.value)})).filter(x=>{const r=roomByNum(x.n);return r&&r2(r.precio)!==x.p});
    if(!ch.length){toast('No hay cambios de precio.');return}
    const rows=await run(sb.from('habitaciones').upsert(ch.map(x=>({numero:x.n,precio:x.p}))).select(),'Precios guardados');
    if(Array.isArray(rows)){rows.forEach(r=>upsertLocal('habitaciones',r));render()}
  },
  async obs(f){
    const n=+f.dataset.id,observaciones=val('o-texto');
    const row=await run(sb.from('habitaciones').update({observaciones}).eq('numero',n).select().single(),observaciones?'Observaciones guardadas':'Observaciones borradas');
    if(row&&row!==true){upsertLocal('habitaciones',row);render();roomSheet(n)}
  },
  async tenant(f){
    const id=f.dataset.id,old=id?tenantById(id):null;
    const d={nombre:val('t-nombre'),celular:val('t-cel'),dni:val('t-dni'),habitacion:old&&!old.activo?old.habitacion:+val('t-room'),
      monto:r2(val('t-monto')),fecha_ingreso:val('t-ing'),dia_pago:Math.min(31,Math.max(1,parseInt(val('t-dia'))||1)),
      garantia:r2(val('t-gar')),notas:val('t-notas')};
    if(!d.nombre||!d.fecha_ingreso||!d.habitacion){toast('Completa nombre, habitación y fecha de ingreso.');return}
    const btn=$('t-save');btn.disabled=true;
    const row=old?await run(sb.from('inquilinos').update(d).eq('id',id).select().single(),'Datos guardados')
                 :await run(sb.from('inquilinos').insert(d).select().single(),'Inquilino registrado');
    if(row&&row!==true){
      upsertLocal('inquilinos',row);
      // Nadie se registra sin pagar: el primer mes queda pagado
      if(!old&&d.monto>0){
        const pago=await run(sb.from('pagos').insert({inquilino_id:row.id,habitacion:row.habitacion,periodo:d.fecha_ingreso.slice(0,7),
          monto:d.monto,fecha:d.fecha_ingreso,metodo:val('t-met')||'Efectivo',nota:'Primer mes, al registrar'}).select().single());
        if(pago&&pago!==true)upsertLocal('pagos',pago);
        else toast('El inquilino quedó registrado, pero no su primer pago. Regístralo desde su ficha.');
      }
      render();tenantSheet(row.id);
    }
    btn.disabled=false;
  },
  async pago(){
    const tid=val('p-inq'),t=tenantById(tid),monto=r2(val('p-monto'));
    if(!t||!val('p-per')||!(monto>0)||!val('p-fecha')){toast('Completa inquilino, mes, monto y fecha.');return}
    const btn=$('p-save');btn.disabled=true;btn.textContent='Guardando…';
    let comprobante=null;
    const file=$('p-foto')&&$('p-foto').files[0];
    if(file){
      const path=val('p-per')+'/'+uuid()+'.jpg';
      const {error}=await sb.storage.from('comprobantes').upload(path,await comprimir(file),{contentType:'image/jpeg'});
      if(error)toast('No se pudo subir la foto. Se guardará el pago sin ella.');else comprobante=path;
    }
    const d={inquilino_id:tid,habitacion:t.habitacion,periodo:val('p-per'),monto,fecha:val('p-fecha'),metodo:val('p-met'),nota:val('p-nota'),comprobante};
    const row=await run(sb.from('pagos').insert(d).select().single());
    if(!row||row===true){btn.disabled=false;btn.textContent='Guardar pago';return}
    upsertLocal('pagos',row);render();
    openSheet(sheetHead('Pago registrado')+`<p style="margin:0 0 16px">${money(monto)} de <b>${esc(t.nombre)}</b> por ${esc(pLabel(d.periodo))}.</p><div class="row">${waBtn(t,'gracias','Enviar confirmación',row)}<button class="btn" data-act="close">Listo</button></div>`);
  },
  async nota(f){
    const tid=f.dataset.id,texto=val('n-texto'),fecha=val('n-fecha')||HOY;
    if(!texto){toast('Escribe la nota.');$('n-texto').focus();return}
    const row=await run(sb.from('notas').insert({inquilino_id:tid,fecha,texto}).select().single(),'Nota agregada');
    if(row&&row!==true){upsertLocal('notas',row);tenantSheet(tid,true);schedule()}
  }
};

/* ============================================================
   ACCIONES
   ============================================================ */
const ACTS={
  view(b){S.view=b.dataset.view;lsSet('hc-view',S.view);closeSheet();render();window.scrollTo(0,0)},
  room(b){roomSheet(b.dataset.id)},
  tenant(b){tenantSheet(b.dataset.id)},
  tenantForm(b){tenantForm(b.dataset.id,b.dataset.room)},
  pago(b){pagoForm(b.dataset.id,b.dataset.periodo)},
  pagoVer(b){pagoSheet(b.dataset.id)},
  close(){closeSheet()},
  confirmYes(){const f=CONFIRM;CONFIRM=null;if(f)f()},
  calMove(b){S.calP=pAdd(S.calP||curP(),+b.dataset.d);S.calDay=null;render()},
  calDay(b){S.calDay=b.dataset.day;render()},
  export(){exportar()},
  bloquear(){bloquear()},
  async buscarDni(){
    const dni=val('t-dni').replace(/\D/g,'');
    if(dni.length!==8){toast('El DNI debe tener 8 números.');return}
    const b=$('t-dni-btn');b.disabled=true;b.textContent='Buscando…';
    const r=await fn('dni',{dni});
    b.disabled=false;b.textContent='Buscar';
    if(r.error){toast({sin_token:'La búsqueda por DNI aún no está activada.',no_encontrado:'No se encontró ese DNI.',dni_invalido:'El DNI debe tener 8 números.',servicio_caido:'El servicio de DNI no responde. Escribe el nombre a mano.'}[r.error]||'No se pudo buscar el DNI.');return}
    const nombre=titleCase([r.nombres,r.apellido_paterno,r.apellido_materno].filter(Boolean).join(' ')||r.nombre_completo);
    $('t-nombre').value=nombre;toast('Nombre encontrado');$('t-cel').focus();
  },
  addRoom(){const n=S.rooms.reduce((m,r)=>Math.max(m,r.numero),0)+1;
    run(sb.from('habitaciones').insert({numero:n,precio:r2(cfg().precio_base)}).select().single(),'Habitación '+pad(n)+' agregada').then(row=>{if(row&&row!==true){upsertLocal('habitaciones',row);render()}})},
  retirar(b){const t=tenantById(b.dataset.id),st=ST.get(t.id),nn=S.notas.filter(x=>x.inquilino_id===t.id).length;
    confirmSheet('Registrar salida',`${esc(t.nombre)} dejará la habitación ${roomNo(t.habitacion)} y quedará libre.${st&&st.deuda>0?` <b style="color:var(--bad)">Tiene una deuda de ${money(st.deuda)}.</b>`:''} Su historial de pagos se conserva.`,'Registrar salida',
      async()=>{
        const borrar=nn&&$('ret-notas')&&$('ret-notas').checked;
        const row=await run(sb.from('inquilinos').update({activo:false,fecha_salida:HOY}).eq('id',t.id).select().single(),'Salida registrada');
        if(!row||row===true)return;
        upsertLocal('inquilinos',row);
        if(borrar&&await run(sb.from('notas').delete().eq('inquilino_id',t.id))){S.notas=S.notas.filter(x=>x.inquilino_id!==t.id)}
        closeSheet();render();
      },nn?`<label class="check" style="margin-bottom:16px"><input type="checkbox" id="ret-notas" checked> Borrar también sus ${nn} nota${nn>1?'s':''} de la bitácora</label>`:'')},
  delTenant(b){const t=tenantById(b.dataset.id);
    confirmSheet('Eliminar registro',`Se borrará a ${esc(t.nombre)} por completo, con su bitácora. Úsalo solo si lo registraste por error.`,'Eliminar',
      async()=>{if(await run(sb.from('inquilinos').delete().eq('id',t.id),'Registro eliminado')){removeLocal('inquilinos',t.id);S.notas=S.notas.filter(x=>x.inquilino_id!==t.id);closeSheet();render()}})},
  async delNota(b){
    if(!b.classList.contains('armed')){b.classList.add('armed');b.textContent='¿Borrar?';setTimeout(()=>{if(b.isConnected){b.classList.remove('armed');b.textContent='✕'}},3000);return}
    if(await run(sb.from('notas').delete().eq('id',b.dataset.id),'Nota borrada')){removeLocal('notas',b.dataset.id);tenantSheet(b.dataset.t,true);schedule()}
  },
  delNotas(b){const t=tenantById(b.dataset.id),nn=S.notas.filter(x=>x.inquilino_id===t.id).length;
    confirmSheet('Borrar bitácora',`Se borrarán las ${nn} notas de ${esc(t.nombre)}. No se puede deshacer.`,'Borrar todas',
      async()=>{if(await run(sb.from('notas').delete().eq('inquilino_id',t.id),'Bitácora borrada')){S.notas=S.notas.filter(x=>x.inquilino_id!==t.id);tenantSheet(t.id);schedule()}})},
  delPago(b){const x=S.pagos.find(p=>p.id===b.dataset.id);
    confirmSheet('Eliminar pago',`Se borrará el pago de ${money(x.monto)} de ${esc(pLabel(x.periodo))}. La deuda del inquilino se recalculará.`,'Eliminar pago',
      async()=>{if(await run(sb.from('pagos').delete().eq('id',x.id),'Pago eliminado')){removeLocal('pagos',x.id);if(x.comprobante)sb.storage.from('comprobantes').remove([x.comprobante]);closeSheet();render()}})}
};
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-act]');
  if(!b||b.tagName==='SELECT'||b.tagName==='INPUT')return;
  if(b.dataset.act==='closeBg'){if(e.target===b)closeSheet();return}
  const f=ACTS[b.dataset.act];if(f){if(b.tagName!=='A')e.preventDefault();f(b,e)}
});
document.addEventListener('submit',e=>{const f=FORMS[e.target.dataset.form];if(f){e.preventDefault();f(e.target)}});
document.addEventListener('change',e=>{
  const a=e.target.dataset.act;
  if(a==='pagMes'){S.pagP=e.target.value;render()}
  else if(a==='toggleRet'){S.showRet=e.target.checked;render()}
  else if(a==='pagoInq'){const po=periodOptions(e.target.value);$('p-per').innerHTML=po.html;$('p-monto').value=po.first?po.first.saldo||'':''}
  else if(a==='pagoPer'){const o=e.target.selectedOptions[0];$('p-monto').value=+o.dataset.saldo||''}
});
let qT;
document.addEventListener('input',e=>{if(e.target.dataset.act==='buscar'){S.q=e.target.value;clearTimeout(qT);qT=setTimeout(render,250)}});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape')closeSheet();
  if(e.key==='Enter'&&e.target.id==='t-dni'){e.preventDefault();ACTS.buscarDni()}
});
const tip=$('tip');
function showTip(b){const r=b.getBoundingClientRect();tip.textContent=b.dataset.tip;tip.hidden=false;tip.style.left=(r.left+r.width/2)+'px';tip.style.top=(r.top+r.height-(b.firstElementChild?b.firstElementChild.offsetHeight:0))+'px'}
document.addEventListener('pointerover',e=>{const b=e.target.closest('.col');if(b)showTip(b);else tip.hidden=true});
document.addEventListener('focusin',e=>{const b=e.target.closest('.col');if(b)showTip(b);else tip.hidden=true});
document.addEventListener('scroll',()=>{tip.hidden=true},{passive:true});

/* ============================================================
   EXCEL
   ============================================================ */
function loadXLSX(){return window.XLSX?Promise.resolve():new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s)})}
async function exportar(){
  toast('Preparando el archivo…');
  try{await loadXLSX()}catch(e){toast('No se pudo preparar el Excel. Revisa tu conexión.');return}
  recompute();
  const X=window.XLSX,wb=X.utils.book_new();
  const pagos=[...S.pagos].sort((a,b)=>(a.fecha||'').localeCompare(b.fecha||'')).map(x=>{const t=tenantById(x.inquilino_id);return {'Fecha':fmtS(x.fecha),'Mes que cubre':pLabel(x.periodo),'Habitación':roomNo(x.habitacion),'Inquilino':t?t.nombre:'','Monto (S/)':+x.monto||0,'Método':x.metodo||'','Nota':x.nota||'','Registrado por':perfilNombre(x.registrado_por)}});
  const inq=[...S.tenants].sort((a,b)=>a.habitacion-b.habitacion).map(t=>{const st=ST.get(t.id);return {'Habitación':roomNo(t.habitacion),'Nombre':t.nombre,'DNI':t.dni||'','Celular':t.celular||'','Ingreso':fmtS(t.fecha_ingreso),'Día de pago':+t.dia_pago,'Monto (S/)':+t.monto||0,'Garantía (S/)':+t.garantia||0,'Estado':st?statusText(st):'Retirado','Deuda (S/)':st?st.deuda:0,'Salida':t.fecha_salida?fmtS(t.fecha_salida):''}});
  const notas=[...S.notas].sort((a,b)=>a.fecha.localeCompare(b.fecha)).map(n=>{const t=tenantById(n.inquilino_id);return {'Fecha':fmtS(n.fecha),'Habitación':t?roomNo(t.habitacion):'','Inquilino':t?t.nombre:'','Nota':n.texto,'Anotado por':perfilNombre(n.autor)}});
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(pagos.length?pagos:[{'Fecha':'Sin pagos'}]),'Pagos');
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(inq.length?inq:[{'Nombre':'Sin inquilinos'}]),'Inquilinos');
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(notas.length?notas:[{'Nota':'Sin notas'}]),'Bitácora');
  X.writeFile(wb,'habitaciones-'+HOY+'.xlsx');
}

/* ============================================================
   ARRANQUE
   ============================================================ */
setInterval(()=>{const h=hoyStr();if(h!==HOY){HOY=h;if(S.yo&&S.view!=='ajustes')render()}},60000);
iniciar();
})();
