const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = { categories:[], providers:[], employees:[], accounts:[], transactions:[], internalTransfers:[], providerImportRows:[], employeeImportRows:[], charts:{}, importRows:[], importMeta:null, bankImports:[], bankKind:'checks', bankData:null };
const ARS = new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0});
const money = n => ARS.format(Number(n||0));
const todayLocal = () => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Cordoba',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const fmtDate = s => { if(!s) return '-'; const [y,m,d]=s.split('-'); return `${d}/${m}/${y}`; };
const paymentText = m => ({cash:'Efectivo',transfer:'Transferencia',check:'Cheque',echeck:'Cheque electrónico',unspecified:'Sin definir'})[m||'unspecified']||'Sin definir';
const isCheckPayment = m => ['check','echeck'].includes(m);
const checkLast5 = v => { const d=String(v??'').replace(/\D/g,''); return d?d.slice(-5):''; };
const validCheckLast5 = v => /^\d{5}$/.test(String(v||''));

function toast(msg,error=false){ const el=$('#toast'); el.textContent=msg; el.className='toast show'+(error?' error':''); clearTimeout(window.__toast); window.__toast=setTimeout(()=>el.className='toast',2800); }
async function api(url, opts={}){
  const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});
  let data=null; try{data=await r.json()}catch{}
  if(!r.ok){ if(r.status===401 && !url.includes('/auth/login')) showLogin(); throw new Error(data?.error||'Ocurrió un error'); }
  return data;
}
function showLogin(){ $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden'); }
function showApp(){ $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden'); }

async function boot(){
  $('#todayLabel').textContent=new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Cordoba',weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date());
  try{ await api('/api/auth/me'); showApp(); await loadReference(); await loadDashboard(); }catch{ showLogin(); }
}

$('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{ await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:$('#loginUser').value,password:$('#loginPass').value})}); showApp(); await loadReference(); await loadDashboard(); toast('Sesión iniciada'); }
  catch(err){ toast(err.message,true); }
});
$('#logoutBtn').onclick=async()=>{ await api('/api/auth/logout',{method:'POST'}).catch(()=>{}); showLogin(); };

async function loadReference(){
  const [categories,providers,employees,accounts]=await Promise.all([api('/api/categories'),api('/api/providers'),api('/api/employees'),api('/api/accounts')]);
  state.categories=categories; state.providers=providers; state.employees=employees; state.accounts=accounts;
  fillReferenceInputs();
}
function isSalaryCategory(name){return normalizeText(name||'').includes('sueldo')}
function providerByName(name){const n=normalizeText(name||'');return state.providers.find(p=>normalizeText(p.name)===n)||null}
function categoriesForProvider(type,name){
  const all=state.categories.filter(c=>!type||c.type===type);const p=providerByName(name);
  if(!p||!Array.isArray(p.categories)||!p.categories.length)return all;
  const allowed=new Set(p.categories);return [...all.filter(c=>allowed.has(c.name)),...all.filter(c=>!allowed.has(c.name))];
}
function fillReferenceInputs(){
  const options=state.categories.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  $('#fCategory').innerHTML=options; $('#iCategory').innerHTML=state.categories.filter(c=>c.type==='expense'&&!isSalaryCategory(c.name)).map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  const bulkCat=$('#bulkCategory'); if(bulkCat) bulkCat.innerHTML='<option value="">No cambiar</option>'+options;
  $('#providerNames').innerHTML=state.providers.map(p=>`<option value="${esc(p.name)}"></option>`).join('');
  $('#employeeNames').innerHTML=state.employees.map(e=>`<option value="${esc(e.name)}"></option>`).join('');
  const accOpts=state.accounts.map(a=>`<option value="${a._id}">${esc(a.name)} · ${money(a.currentBalance)}</option>`).join('');
  $('#fAccount').innerHTML='<option value="">Elegir cuenta…</option>'+accOpts;
  const iAcc=$('#iAccount'); if(iAcc)iAcc.innerHTML='<option value="">Elegir cuenta…</option>'+accOpts;
  const bulkAcc=$('#bulkAccount'); if(bulkAcc)bulkAcc.innerHTML='<option value="">No cambiar</option>'+accOpts;
  const bankAcc=$('#bankAccountSelect'); if(bankAcc)bankAcc.innerHTML='<option value="">Todas / sin asignar</option>'+state.accounts.map(a=>`<option value="${a._id}">${esc(a.name)}</option>`).join('');
  const intOpts='<option value="">Elegir cuenta…</option>'+state.accounts.map(a=>`<option value="${a._id}">${esc(a.name)} · ${money(a.currentBalance)}</option>`).join(''); const iFrom=$('#internalFrom'),iTo=$('#internalTo'); if(iFrom)iFrom.innerHTML=intOpts;if(iTo)iTo.innerHTML=intOpts;
}
function esc(v=''){ return String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

$$('.nav-btn[data-page]').forEach(b=>b.onclick=()=>go(b.dataset.page));
$$('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));
$('#menuBtn').onclick=()=>$('#sidebar').classList.toggle('open');
function go(page){
  $$('.page').forEach(x=>x.classList.remove('active')); $(`#page-${page}`).classList.add('active');
  $$('.nav-btn[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page)); $('#sidebar').classList.remove('open');
  const titles={dashboard:'¿Cómo estamos?',transactions:'Movimientos',upcoming:'Próximos pagos y cobros',accounts:'Cuentas',internal:'Cuentas propias',providers:'Proveedores y clientes',employees:'Empleados',import:'Importar Excel',bankcontrol:'Control bancario',reports:'Reportes'};
  $('#pageTitle').textContent=titles[page]||'Las Tres Marías';
  if(page==='dashboard') loadDashboard(); if(page==='transactions') loadTransactions(); if(page==='upcoming') loadUpcoming(); if(page==='accounts') loadAccounts(); if(page==='internal') loadInternalTransfers(); if(page==='providers') loadProviders(); if(page==='employees') loadEmployees(); if(page==='import') prepareImportPage(); if(page==='bankcontrol') loadBankControl(); if(page==='reports') loadStorageStatus();
}

async function loadDashboard(){
  const d=await api('/api/dashboard');
  $('#mCurrent').textContent=money(d.currentBalance); $('#mReceivable').textContent=money(d.pendingIncome); $('#mPayable').textContent=money(d.pendingExpense); $('#mProjected').textContent=money(d.projectedBalance);
  $('#m30in').textContent=money(d.next30Income); $('#m30out').textContent=money(d.next30Expense); $('#mOverdue').textContent=money(d.overdueExpense);
  renderList($('#dashboardUpcoming'),d.upcoming,true); renderProjection(d); renderCategories(d);
}
function renderList(el,items,compact=false){
  if(!items?.length){ el.innerHTML='<div class="list-item"><div></div><div><small>No hay movimientos para mostrar.</small></div></div>'; return; }
  el.innerHTML=items.map(t=>`<div class="list-item"><span class="date-pill">${fmtDate(t.dueDate)}</span><div><strong>${esc(t.counterparty)}</strong><small>${esc(t.category)} · ${esc(paymentText(t.paymentMethod))}${isCheckPayment(t.paymentMethod)&&t.checkNumber?` · Últ. 5: ${esc(checkLast5(t.checkNumber))}`:''}${t.installmentNumber?` · Cuota ${t.installmentNumber}/${t.installmentCount}`:''}</small></div><span class="amount ${t.type}">${t.type==='income'?'+':'−'} ${money(t.amount)}</span><span class="status ${t.status}">${statusText(t.status)}</span></div>`).join('');
}
function statusText(s){return s==='paid'?'Pagado':s==='pending'?'Pendiente':'Cancelado'}
function renderProjection(d){
  const ctx=$('#projectionChart'); if(state.charts.projection) state.charts.projection.destroy();
  let labels=[d.today], vals=[d.currentBalance];
  for(const p of d.projection){ labels.push(p.date); vals.push(p.balance); }
  const reduced=[]; const reducedVals=[];
  labels.forEach((x,i)=>{ if(i===0||i===labels.length-1||i%Math.max(1,Math.floor(labels.length/40))===0){reduced.push(x);reducedVals.push(vals[i]);} });
  state.charts.projection=new Chart(ctx,{type:'line',data:{labels:reduced.map(fmtDate),datasets:[{label:'Saldo',data:reducedVals,borderWidth:3,tension:.22,pointRadius:0,fill:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>money(c.raw)}}},scales:{y:{ticks:{callback:v=>money(v)}}}}});
}
function renderCategories(d){
  const ctx=$('#categoryChart'); if(state.charts.category) state.charts.category.destroy();
  state.charts.category=new Chart(ctx,{type:'doughnut',data:{labels:d.categories.map(x=>x._id),datasets:[{data:d.categories.map(x=>x.total)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'},tooltip:{callbacks:{label:c=>`${c.label}: ${money(c.raw)}`}}}}});
}

async function loadTransactions(){
  const p=new URLSearchParams(); if($('#txSearch').value)p.set('search',$('#txSearch').value); if($('#txType').value)p.set('type',$('#txType').value); if($('#txStatus').value)p.set('status',$('#txStatus').value); if($('#txPayment').value)p.set('paymentMethod',$('#txPayment').value); if($('#txControlled').value)p.set('controlled',$('#txControlled').value);
  state.transactions=await api('/api/transactions?'+p.toString()); renderTransactions();
}
function renderTransactions(){
  $('#txTable').innerHTML=state.transactions.map(t=>`<tr class="${t.controlled?'controlled-row':''}"><td><label class="control-check"><input type="checkbox" ${t.controlled?'checked':''} onchange="setControlled('${t._id}',this.checked)"><span>${t.controlled?'Controlado':'Sin controlar'}</span></label></td><td>${fmtDate(t.dueDate)}</td><td><span class="amount ${t.type}">${t.type==='income'?'Ingreso':'Egreso'}</span></td><td><strong>${esc(t.counterparty)}</strong></td><td>${esc(t.category)}</td><td class="amount ${t.type}">${money(t.amount)}</td><td><span class="status ${t.status}">${statusText(t.status)}</span></td><td>${esc(paymentText(t.paymentMethod))}</td><td>${esc(checkLast5(t.checkNumber)||'—')}</td><td>${esc(t.account?.name||'—')}</td><td><div class="row-actions">${t.status==='pending'?`<button title="Marcar pagado/cobrado" onclick="markPaid('${t._id}')">✓</button>`:''}<button title="Editar" onclick="editTx('${t._id}')">✎</button><button title="Eliminar" onclick="deleteTx('${t._id}')">×</button></div></td></tr>`).join('');
}
let searchTimer; $('#txSearch').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(loadTransactions,300)}); $('#txType').onchange=loadTransactions; $('#txStatus').onchange=loadTransactions; $('#txPayment').onchange=loadTransactions; $('#txControlled').onchange=loadTransactions;

async function loadUpcoming(){
  const tx=await api('/api/transactions?status=pending&limit=1000'); const sorted=tx.sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  renderList($('#upcomingExpenses'),sorted.filter(x=>x.type==='expense')); renderList($('#upcomingIncome'),sorted.filter(x=>x.type==='income'));
}
async function loadAccounts(){
  state.accounts=await api('/api/accounts'); fillReferenceInputs();
  $('#accountsGrid').innerHTML=state.accounts.map(a=>`<article class="account-card"><span>${accountType(a.type)}</span><h3>${esc(a.name)}</h3><strong>${money(a.currentBalance)}</strong><p class="hint">Saldo inicial: ${money(a.openingBalance)}</p><button class="btn secondary" onclick="editAccount('${a._id}')">Editar</button></article>`).join('');
}
function accountType(t){return ({bank:'Banco',cash:'Efectivo',wallet:'Billetera',usd:'Dólares',other:'Otra'})[t]||t}
function providerRoleText(r){return r==='client'?'Cliente':r==='both'?'Proveedor y cliente':'Proveedor'}
async function loadProviders(){
  state.providers=await api('/api/providers'); fillReferenceInputs();
  $('#providerTable').innerHTML=state.providers.map(p=>`<tr><td><strong>${esc(p.name)}</strong></td><td>${esc(providerRoleText(p.role))}</td><td>${(p.categories||[]).length?(p.categories||[]).map(c=>`<span class="tag">${esc(c)}</span>`).join(' '):'—'}</td><td>${esc(p.notes||'')}</td><td><button class="btn secondary" onclick="editProvider('${p._id}')">Editar</button></td></tr>`).join('');
}
async function loadEmployees(){
  state.employees=await api('/api/employees'); fillReferenceInputs();
  $('#employeeTable').innerHTML=state.employees.map(e=>`<tr><td><strong>${esc(e.name)}</strong></td><td>${esc(e.notes||'')}</td><td><button class="btn secondary" onclick="editEmployee('${e._id}')">Editar</button></td></tr>`).join('');
}

$('#newTxBtn').onclick=()=>openTx();
function refreshTxCategoryOptions(selected=''){
  const type=$('#fType').value||'expense',name=$('#fCounterparty').value.trim();let cats=categoriesForProvider(type,name);
  if(selected&&!cats.some(c=>c.name===selected)){const c=state.categories.find(x=>x.name===selected&&x.type===type);if(c)cats=[c,...cats]}
  $('#fCategory').innerHTML=cats.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  $('#fCategory').value=selected&&cats.some(c=>c.name===selected)?selected:(cats[0]?.name||'');toggleEmployeeField();
}
function toggleEmployeeField(){
  const salary=isSalaryCategory($('#fCategory').value);$('#employeeField').classList.toggle('hidden',!salary);$('#counterpartyField').classList.toggle('hidden',salary);
  $('#fEmployee').required=salary;$('#fCounterparty').required=!salary;
}
function toggleCheckNumberField(){const show=isCheckPayment($('#fPaymentMethod').value);$('#checkNumberField').classList.toggle('hidden',!show);$('#fCheckNumber').required=show;$('#fCheckNumber').maxLength=5;$('#fCheckNumber').inputMode='numeric';if(!show)$('#fCheckNumber').value='';}
function openTx(tx=null,voicePhrase=''){
  $('#txForm').reset(); $('#txId').value=tx?._id||''; $('#txSource').value=tx?.source||'manual';
  $('#txDialogTitle').textContent=tx?'Editar movimiento':(voicePhrase?'Confirmar movimiento interpretado':'Nuevo movimiento');
  $('#txOriginText').textContent=voicePhrase?'Revisá los datos antes de guardar. Nada se guarda automáticamente.':'Carga manual';
  $('#fType').value=tx?.type||'expense'; $('#fStatus').value=tx?.status||'pending'; $('#fCounterparty').value=isSalaryCategory(tx?.category)?'':(tx?.counterparty||'');
  refreshTxCategoryOptions(tx?.category||bestCategory($('#fType').value));
  $('#fAmount').value=tx?.amount||''; $('#fDate').value=tx?.date||todayLocal(); $('#fDueDate').value=tx?.dueDate||todayLocal(); $('#fPaymentMethod').value=tx?.paymentMethod||'unspecified'; $('#fCheckNumber').value=checkLast5(tx?.checkNumber||''); $('#fAccount').value=tx?.account?._id||tx?.account||''; $('#fNotes').value=tx?.notes||'';
  const txEmployee=tx?.employee?state.employees.find(e=>e._id===(tx.employee?._id||tx.employee)):null;
  $('#fEmployee').value=isSalaryCategory(tx?.category)?(txEmployee?.name||tx?.counterparty||''):''; toggleEmployeeField(); toggleCheckNumberField();
  const v=$('#voiceOriginal'); if(voicePhrase){v.classList.remove('hidden');v.textContent='Frase original: “'+voicePhrase+'”';}else v.classList.add('hidden');
  $('#txDialog').showModal();
}
function bestCategory(type){return state.categories.find(c=>c.type===type)?.name||state.categories[0]?.name||''}
$('#fType').onchange=()=>refreshTxCategoryOptions('');
$('#fCounterparty').addEventListener('change',()=>{const p=providerByName($('#fCounterparty').value);const current=$('#fCategory').value;refreshTxCategoryOptions((p?.categories||[]).length===1?p.categories[0]:current)});
$('#fCounterparty').addEventListener('blur',()=>{const p=providerByName($('#fCounterparty').value);if(p&&(p.categories||[]).length===1)refreshTxCategoryOptions(p.categories[0])});
$('#fCategory').onchange=toggleEmployeeField; $('#fPaymentMethod').onchange=toggleCheckNumberField;

function entityDialogPromise({title,subtitle,fields,onSave}){
  return new Promise(resolve=>{
    const dialog=$('#simpleDialog'),form=$('#simpleForm');let settled=false;
    $('#simpleTitle').textContent=title;$('#simpleSubtitle').textContent=subtitle||'';$('#simpleFields').innerHTML=fields;
    const finish=value=>{if(settled)return;settled=true;dialog.removeEventListener('close',onClose);resolve(value)};
    const onClose=()=>finish(null);dialog.addEventListener('close',onClose);
    form.onsubmit=async ev=>{ev.preventDefault();try{const value=await onSave(new FormData(form));finish(value);dialog.close();}catch(err){toast(err.message,true)}};
    dialog.showModal();
  });
}
async function promptCreateProviderForMovement(name,type,category){
  const role=type==='income'?'client':'provider';
  const cats=state.categories.filter(c=>!isSalaryCategory(c.name)).map(c=>`<label class="check-item"><input type="checkbox" name="categories" value="${esc(c.name)}" ${c.name===category?'checked':''}> ${esc(c.name)}</label>`).join('');
  const created=await entityDialogPromise({title:'Proveedor / cliente no cargado',subtitle:`“${name}” no existe todavía. Completá su ficha y, al guardarla, el movimiento continuará automáticamente.`,fields:`<label class="span2">Nombre<input name="name" required value="${esc(name)}"></label><label>Tipo<select name="role"><option value="provider" ${role==='provider'?'selected':''}>Proveedor</option><option value="client" ${role==='client'?'selected':''}>Cliente</option><option value="both">Proveedor y cliente</option></select></label><div class="span2"><span class="field-label">Categorías habituales</span><div class="check-grid">${cats}</div></div><label class="span2">Notas<input name="notes" placeholder="Opcional"></label>`,onSave:async fd=>{const selected=fd.getAll('categories');if(category&&!selected.includes(category))selected.push(category);return api('/api/providers',{method:'POST',body:JSON.stringify({name:fd.get('name'),role:fd.get('role')||role,categories:selected,notes:fd.get('notes')||''})})}});
  if(created){await loadReference();return providerByName(created.name)||created}return null;
}
async function promptCreateEmployeeForMovement(name){
  const created=await entityDialogPromise({title:'Empleado no cargado',subtitle:`“${name}” no existe todavía. Completá su ficha y, al guardarla, el sueldo continuará automáticamente.`,fields:`<label class="span2">Nombre<input name="name" required value="${esc(name)}"></label><label class="span2">Notas<input name="notes" placeholder="Opcional"></label>`,onSave:async fd=>api('/api/employees',{method:'POST',body:JSON.stringify({name:fd.get('name'),notes:fd.get('notes')||''})})});
  if(created){await loadReference();return state.employees.find(e=>normalizeText(e.name)===normalizeText(created.name))||created}return null;
}
async function ensureMovementEntity(body){
  if(isSalaryCategory(body.category)){
    const typed=$('#fEmployee').value.trim();if(!typed)throw new Error('Falta empleado para el sueldo');
    let emp=state.employees.find(e=>normalizeText(e.name)===normalizeText(typed));
    if(!emp){emp=await promptCreateEmployeeForMovement(typed);if(!emp)throw new Error('No se guardó el movimiento porque falta crear el empleado');}
    body.employee=emp._id;body.counterparty=emp.name;$('#fEmployee').value=emp.name;
  }else{
    const typed=String(body.counterparty||'').trim();if(!typed)throw new Error('Falta cliente/proveedor');
    let provider=providerByName(typed);
    if(!provider){provider=await promptCreateProviderForMovement(typed,body.type,body.category);if(!provider)throw new Error('No se guardó el movimiento porque falta crear el proveedor/cliente');}
    body.counterparty=provider.name;$('#fCounterparty').value=provider.name;
  }
  return body;
}
$('#txForm').addEventListener('submit',async e=>{
  e.preventDefault();const salary=isSalaryCategory($('#fCategory').value);
  const body={type:$('#fType').value,status:$('#fStatus').value,counterparty:salary?'':$('#fCounterparty').value.trim(),employee:null,category:$('#fCategory').value,amount:Number($('#fAmount').value),date:$('#fDate').value,dueDate:$('#fDueDate').value,paymentMethod:$('#fPaymentMethod').value,checkNumber:checkLast5($('#fCheckNumber').value),account:$('#fAccount').value||null,notes:$('#fNotes').value.trim(),source:$('#txSource').value};
  try{await ensureMovementEntity(body);const id=$('#txId').value;await api(id?'/api/transactions/'+id:'/api/transactions',{method:id?'PUT':'POST',body:JSON.stringify(body)});$('#txDialog').close();await loadReference();toast(id?'Movimiento actualizado':'Movimiento guardado');const page=$('.page.active').id.replace('page-','');go(page);}
  catch(err){if(!/No se guardó el movimiento porque/.test(err.message))toast(err.message,true)}
});
window.editTx=id=>{ const tx=state.transactions.find(x=>x._id===id); if(tx)openTx(tx); };
window.deleteTx=async id=>{ if(!confirm('¿Eliminar este movimiento?'))return; try{await api('/api/transactions/'+id,{method:'DELETE'});toast('Movimiento eliminado');loadTransactions();}catch(e){toast(e.message,true)} };
window.markPaid=id=>{ const tx=state.transactions.find(x=>x._id===id); if(!tx)return; openTx({...tx,status:'paid'}); $('#txOriginText').textContent='Revisá la cuenta y confirmá antes de marcarlo como realizado.'; };

window.setControlled=async(id,controlled)=>{
  const tx=state.transactions.find(x=>x._id===id); if(tx){tx.controlled=controlled;renderTransactions();}
  try{await api('/api/transactions/'+id+'/controlled',{method:'PATCH',body:JSON.stringify({controlled})});await loadTransactions();toast(controlled?'Movimiento marcado como controlado':'Control quitado');}
  catch(e){if(tx){tx.controlled=!controlled;renderTransactions();}toast(e.message,true);}
};



// ---------------- MOVIMIENTOS ENTRE CUENTAS PROPIAS ----------------
async function loadInternalTransfers(){
  state.internalTransfers=await api('/api/internal-transfers');
  const tb=$('#internalTable');if(!tb)return;
  tb.innerHTML=state.internalTransfers.map(t=>`<tr><td>${fmtDate(t.date)}</td><td><strong>${esc(t.fromAccount?.name||'—')}</strong></td><td><strong>${esc(t.toAccount?.name||'—')}</strong></td><td class="amount">${money(t.amount)}</td><td><span class="status ${t.status}">${t.status==='paid'?'Realizada':t.status==='pending'?'Pendiente':'Cancelada'}</span></td><td>${t.fromControlled?'✓ Controlado':'—'}</td><td>${t.toControlled?'✓ Controlado':'—'}</td><td>${esc(t.notes||'')}</td><td><div class="row-actions"><button title="Editar" onclick="editInternal('${t._id}')">✎</button><button title="Eliminar" onclick="deleteInternal('${t._id}')">×</button></div></td></tr>`).join('')||'<tr><td colspan="9" class="muted">Todavía no hay transferencias entre cuentas propias.</td></tr>';
}
function openInternal(t=null){
  $('#internalForm').reset();$('#internalId').value=t?._id||'';$('#internalDialogTitle').textContent=t?'Editar transferencia propia':'Transferencia entre cuentas propias';
  $('#internalFrom').value=t?.fromAccount?._id||'';$('#internalTo').value=t?.toAccount?._id||'';$('#internalAmount').value=t?.amount||'';$('#internalDate').value=t?.date||todayLocal();$('#internalStatus').value=t?.status||'paid';$('#internalNotes').value=t?.notes||'';$('#internalDialog').showModal();
}
$('#newInternalBtn').onclick=()=>openInternal();
$('#internalForm').addEventListener('submit',async e=>{e.preventDefault();const body={fromAccount:$('#internalFrom').value,toAccount:$('#internalTo').value,amount:Number($('#internalAmount').value),date:$('#internalDate').value,status:$('#internalStatus').value,notes:$('#internalNotes').value.trim()};try{const id=$('#internalId').value;await api(id?'/api/internal-transfers/'+id:'/api/internal-transfers',{method:id?'PUT':'POST',body:JSON.stringify(body)});$('#internalDialog').close();await loadReference();await loadInternalTransfers();toast(id?'Transferencia actualizada':'Transferencia entre cuentas guardada');}catch(err){toast(err.message,true)}});
window.editInternal=id=>{const t=state.internalTransfers.find(x=>x._id===id);if(t)openInternal(t)};
window.deleteInternal=async id=>{if(!confirm('¿Eliminar esta transferencia entre cuentas? Se eliminan ambos lados vinculados.'))return;try{await api('/api/internal-transfers/'+id,{method:'DELETE'});toast('Transferencia eliminada');await loadReference();await loadInternalTransfers();}catch(e){toast(e.message,true)}};

function toggleInstallmentChecks(){const show=isCheckPayment($('#iPaymentMethod').value);$('#installmentCheckField').classList.toggle('hidden',!show);$('#iCheckNumbers').required=show;if(!show)$('#iCheckNumbers').value='';}
$('#installmentBtn').onclick=()=>{ $('#installmentForm').reset(); $('#iFirstDue').value=todayLocal(); toggleInstallmentChecks(); $('#installmentDialog').showModal(); };
$('#iPaymentMethod').onchange=toggleInstallmentChecks;
$('#installmentForm').addEventListener('submit',async e=>{e.preventDefault();try{let counterparty=$('#iCounterparty').value.trim();if(!counterparty)throw new Error('Falta proveedor');let provider=providerByName(counterparty);if(!provider){provider=await promptCreateProviderForMovement(counterparty,'expense',$('#iCategory').value);if(!provider)return;counterparty=provider.name;$('#iCounterparty').value=provider.name;}await api('/api/installments',{method:'POST',body:JSON.stringify({type:'expense',counterparty,category:$('#iCategory').value,totalAmount:Number($('#iTotal').value),count:Number($('#iCount').value),firstDueDate:$('#iFirstDue').value,paymentMethod:$('#iPaymentMethod').value,checkNumbers:$('#iCheckNumbers').value,account:$('#iAccount').value||null,notes:$('#iNotes').value})});$('#installmentDialog').close();toast('Cuotas generadas');loadUpcoming();}catch(err){toast(err.message,true)}});

function openSimple({title,subtitle,fields,onSubmit}){
  $('#simpleTitle').textContent=title; $('#simpleSubtitle').textContent=subtitle||''; $('#simpleFields').innerHTML=fields; $('#simpleDialog').showModal(); $('#simpleForm').onsubmit=async e=>{e.preventDefault();try{await onSubmit(new FormData(e.target));$('#simpleDialog').close();}catch(err){toast(err.message,true)}};
}
$('#newAccountBtn').onclick=()=>openAccount();
function openAccount(a=null){
  openSimple({title:a?'Editar cuenta':'Nueva cuenta',subtitle:'El saldo inicial se suma al historial de movimientos.',fields:`<label class="span2">Nombre<input name="name" required value="${esc(a?.name||'')}"></label><label>Tipo<select name="type"><option value="bank">Banco</option><option value="cash">Efectivo</option><option value="wallet">Billetera</option><option value="usd">Dólares</option><option value="other">Otra</option></select></label><label>Saldo inicial<input name="openingBalance" type="number" step="0.01" value="${a?.openingBalance||0}"></label>`,onSubmit:async fd=>{const body=Object.fromEntries(fd);body.openingBalance=Number(body.openingBalance);await api(a?'/api/accounts/'+a._id:'/api/accounts',{method:a?'PUT':'POST',body:JSON.stringify(body)});toast('Cuenta guardada');await loadAccounts();}});
  setTimeout(()=>{const s=$('#simpleFields select[name=type]');if(s)s.value=a?.type||'bank'},0);
}
window.editAccount=id=>openAccount(state.accounts.find(x=>x._id===id));
$('#newProviderBtn').onclick=()=>openProvider();
function openProvider(p=null){
  const cats=state.categories.filter(c=>!isSalaryCategory(c.name)).map(c=>`<label class="check-item"><input type="checkbox" name="categories" value="${esc(c.name)}" ${(p?.categories||[]).includes(c.name)?'checked':''}> ${esc(c.name)}</label>`).join('');
  openSimple({title:p?'Editar proveedor / cliente':'Nuevo proveedor / cliente',subtitle:'Podés asignarle una o varias categorías. Se usarán para sugerir y filtrar al cargar movimientos.',fields:`<label class="span2">Nombre<input name="name" required value="${esc(p?.name||'')}"></label><label>Tipo<select name="role"><option value="provider">Proveedor</option><option value="client">Cliente</option><option value="both">Proveedor y cliente</option></select></label><div class="span2"><span class="field-label">Categorías del proveedor / cliente</span><div class="check-grid">${cats}</div></div><label class="span2">Notas<input name="notes" value="${esc(p?.notes||'')}"></label>`,onSubmit:async fd=>{const body={name:fd.get('name'),role:fd.get('role'),categories:fd.getAll('categories'),notes:fd.get('notes')};await api(p?'/api/providers/'+p._id:'/api/providers',{method:p?'PUT':'POST',body:JSON.stringify(body)});toast('Proveedor / cliente guardado');await loadProviders();}}); setTimeout(()=>{const r=$('#simpleFields select[name=role]');if(r)r.value=p?.role||'provider'},0);
}
window.editProvider=id=>openProvider(state.providers.find(x=>x._id===id));
$('#newEmployeeBtn').onclick=()=>openEmployee();
function openEmployee(e=null){openSimple({title:e?'Editar empleado':'Nuevo empleado',subtitle:'Los empleados solo se muestran cuando la categoría es Sueldos.',fields:`<label class="span2">Nombre<input name="name" required value="${esc(e?.name||'')}"></label><label class="span2">Notas<input name="notes" value="${esc(e?.notes||'')}"></label>`,onSubmit:async fd=>{const body=Object.fromEntries(fd);await api(e?'/api/employees/'+e._id:'/api/employees',{method:e?'PUT':'POST',body:JSON.stringify(body)});toast('Empleado guardado');await loadEmployees();}})}
window.editEmployee=id=>openEmployee(state.employees.find(x=>x._id===id));

$$('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('#excelBtn').onclick=()=>downloadReport('excel'); $('#pdfBtn').onclick=()=>downloadReport('pdf');
function downloadReport(kind){ const q=new URLSearchParams(); if($('#reportFrom').value)q.set('from',$('#reportFrom').value);if($('#reportTo').value)q.set('to',$('#reportTo').value);window.location=`/api/reports/${kind}?${q}`; }

// ---------------- VOZ ----------------
$('#voiceBtn').onclick=()=>{ $('#voiceText').value='';$('#voiceStatus').textContent='Tocá “Escuchar” y hablá normalmente.';$('#voiceDialog').showModal(); };
let recognition=null;
function speechSupported(){ return !!(window.SpeechRecognition||window.webkitSpeechRecognition); }
$('#listenBtn').onclick=()=>{
  if(!speechSupported()){toast('Este navegador no ofrece reconocimiento de voz. Podés escribir la frase y tocar Interpretar.',true);return;}
  const Rec=window.SpeechRecognition||window.webkitSpeechRecognition; recognition=new Rec(); recognition.lang='es-AR'; recognition.interimResults=true; recognition.continuous=false;
  recognition.onstart=()=>{$('#voiceStatus').textContent='Escuchando…';$('#micCircle').classList.add('listening')};
  recognition.onresult=e=>{let txt='';for(let i=e.resultIndex;i<e.results.length;i++)txt+=e.results[i][0].transcript+' ';$('#voiceText').value=txt.trim()};
  recognition.onerror=e=>{toast('No pude escuchar correctamente: '+e.error,true)};
  recognition.onend=()=>{$('#voiceStatus').textContent='Listo. Revisá el texto o tocá Interpretar.';$('#micCircle').classList.remove('listening')}; recognition.start();
};
$('#interpretBtn').onclick=()=>{
  const phrase=$('#voiceText').value.trim(); if(!phrase)return toast('Primero hablá o escribí una frase.',true);
  const tx=parseVoiceTransaction(phrase); $('#voiceDialog').close(); openTx(tx,phrase);
};

function normalizeText(s){return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim()}
function parseVoiceTransaction(original){
  const s=normalizeText(original); const type=/\b(cobro|cobramos|cobrar|ingreso|ingresa|venta|vendimos|nos paga|nos pagan|recibimos)\b/.test(s)?'income':'expense';
  const amount=extractAmount(s); const dueDate=extractDate(s); let category=extractCategory(original,type); let counterparty=extractCounterparty(original,type,category);
  const provider=findProvider(counterparty); if((provider?.categories||[]).length===1 && !explicitCategory(s)) category=provider.categories[0];
  const paymentMethod=extractPaymentMethod(s); const checkNumber=extractCheckNumber(s,paymentMethod); const account=extractAccount(s);const employee=isSalaryCategory(category)?findEmployeeInText(original):null;
  if(employee)counterparty=employee.name;
  return {type,status:/\b(hoy pague|hoy cobre|ya pague|ya cobre|pague|cobre|pagado|cobrado)\b/.test(s)&&!(/\b(tengo que|hay que|voy a|vamos a|pendiente|vence|vencimiento)\b/.test(s))?'paid':'pending',counterparty:counterparty||'',employee:employee?employee._id:null,category:category||bestCategory(type),amount:amount||'',date:todayLocal(),dueDate:dueDate||todayLocal(),paymentMethod,checkNumber,account:account?account._id:null,notes:'',source:'voice'};
}

function extractPaymentMethod(s){
  if(/\b(e[- ]?cheq|echeq|cheque electronico|cheque electrónico)\b/.test(s)) return 'echeck';
  if(/\btransferencia|transferi|transferí|transferir\b/.test(s)) return 'transfer';
  if(/\befectivo|cash\b/.test(s)) return 'cash';
  if(/\bcheque\b/.test(s)) return 'check';
  return 'unspecified';
}
function extractCheckNumber(s,paymentMethod){if(!isCheckPayment(paymentMethod))return'';const m=s.match(/(?:numero|nro|n[°º]?)\s*(?:de\s+)?(?:cheque|e[- ]?cheq|echeq)?\s*([a-z0-9-]{3,})/i)||s.match(/(?:cheque|e[- ]?cheq|echeq)(?:\s+electronico)?\s+(?:numero|nro|n[°º]?)\s*([a-z0-9-]{3,})/i);return m?checkLast5(m[1]):'';}

function extractAccount(s){
  const n=normalizeText(s); return state.accounts.find(a=>n.includes(normalizeText(a.name)))||null;
}

function explicitCategory(s){return /\bcategoria\b/.test(s)}
function findProvider(name){if(!name)return null;const n=normalizeText(name);return state.providers.find(p=>normalizeText(p.name)===n)||state.providers.find(p=>n.includes(normalizeText(p.name))||normalizeText(p.name).includes(n));}
function findEmployeeInText(text){const n=normalizeText(text||'');return state.employees.find(e=>n.includes(normalizeText(e.name)))||null}
function extractCategory(original,type){
  const s=normalizeText(original); const m=s.match(/\bcategoria\s+(.+?)(?=,|\.|\b(?:por|para|monto|importe|de|el|la)\s+(?:\$|\d)|$)/); if(m){const q=m[1].trim();const found=state.categories.find(c=>normalizeText(c.name).includes(q)||q.includes(normalizeText(c.name)));return found?.name||titleCase(q)}
  if(type==='expense'&&/\b(inversion|infraestructura)\b/.test(s)){const inv=state.categories.find(c=>normalizeText(c.name).includes('inversion')||normalizeText(c.name).includes('infraestructura'));if(inv)return inv.name;}
  const found=state.categories.find(c=>{const n=normalizeText(c.name);return s.includes(n)}); return found?.name||bestCategory(type);
}
function extractCounterparty(original,type,category){
  const s=original.trim(); const clean=s.replace(/\s+/g,' ');
  let m=clean.match(type==='income'?/\b(?:de|a)\s+([^,.;]+?)(?=\s+(?:por|categoria|categoría|\$|\d)|[,.;]|$)/i:/\b(?:a|de)\s+([^,.;]+?)(?=\s+(?:por|categoria|categoría|\$|\d)|[,.;]|$)/i);
  if(m){let v=m[1].trim(); if(!/^(hoy|manana|mañana|el|la)$/i.test(v))return titleCase(v)}
  const known=state.providers.find(p=>normalizeText(clean).includes(normalizeText(p.name))); return known?.name||'';
}
function extractAmount(s){
  const peso=s.match(/((?:\d[\d.,]*|[a-z]+)(?:\s+(?:\d[\d.,]*|[a-z]+)){0,9})\s+pesos?\b/); if(peso){const n=parseNumberWords(peso[1]);if(n)return n}
  const dollar=s.match(/\$\s*([\d.]+(?:,\d+)?)/); if(dollar)return parseLocaleNumber(dollar[1]);
  const million=s.match(/\b(\d+(?:[.,]\d+)?)\s*(millones?|millon|palos?)\b/); if(million)return Number(million[1].replace(',','.'))*1e6;
  const explicit=s.match(/\b(?:monto|importe|por)\s+(\d[\d.,]*)\b/); if(explicit)return parseLocaleNumber(explicit[1]);
  return 0;
}
function parseLocaleNumber(v){v=String(v);if(v.includes('.')&&v.includes(','))return Number(v.replace(/\./g,'').replace(',','.'));if((v.match(/\./g)||[]).length>1||/\.\d{3}$/.test(v))return Number(v.replace(/\./g,''));return Number(v.replace(',','.'))}
function parseNumberWords(str){
  str=normalizeText(str).replace(/\by\b/g,' '); if(/\d/.test(str)){const mm=str.match(/(\d+(?:[.,]\d+)?)\s*millones?/);const kk=str.match(/(\d+(?:[.,]\d+)?)\s*mil/);if(mm||kk){let n=0;if(mm)n+=Number(mm[1].replace(',','.'))*1e6;if(kk)n+=Number(kk[1].replace(',','.'))*1e3;const tail=str.replace(/\d+(?:[.,]\d+)?\s*(millones?|mil)/g,' ').match(/\b\d[\d.,]*\b/);if(tail)n+=parseLocaleNumber(tail[0]);return n}const nums=str.match(/\d[\d.,]*/g);if(nums)return parseLocaleNumber(nums[0])}
  const small={cero:0,un:1,uno:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12,trece:13,catorce:14,quince:15,dieciseis:16,diecisiete:17,dieciocho:18,diecinueve:19,veinte:20,veintiuno:21,veintidos:22,veintitres:23,veinticuatro:24,veinticinco:25,veintiseis:26,veintisiete:27,veintiocho:28,veintinueve:29,treinta:30,cuarenta:40,cincuenta:50,sesenta:60,setenta:70,ochenta:80,noventa:90,cien:100,ciento:100,doscientos:200,trescientos:300,cuatrocientos:400,quinientos:500,seiscientos:600,setecientos:700,ochocientos:800,novecientos:900};
  let total=0,current=0; for(const w of str.split(' ')){ if(w==='millon'||w==='millones'){total+=Math.max(1,current)*1e6;current=0}else if(w==='mil'){total+=Math.max(1,current)*1e3;current=0}else if(small[w]!=null){current+=small[w]}} return total+current;
}
function extractDate(s){
  const now=new Date(); const ymd=todayLocal(); const [cy,cm,cd]=ymd.split('-').map(Number);
  if(/\bhoy\b/.test(s))return ymd; if(/\bmanana\b/.test(s)){const d=new Date(cy,cm-1,cd+1);return localYMD(d)};
  let m=s.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/); if(m){let y=m[3]?Number(m[3]):cy;if(y<100)y+=2000;return `${y}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`}
  const months={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};
  m=s.match(/\b(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?/); if(m){let y=m[3]?Number(m[3]):cy;const mo=months[m[2]];if(!m[3]&&(mo<cm||(mo===cm&&Number(m[1])<cd)))y++;return `${y}-${String(mo).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`}
  const days={domingo:0,lunes:1,martes:2,miercoles:3,jueves:4,viernes:5,sabado:6}; for(const [name,dow] of Object.entries(days)){if(new RegExp(`\\b${name}\\b`).test(s)){const d=new Date(cy,cm-1,cd);let diff=(dow-d.getDay()+7)%7;if(diff===0)diff=7;d.setDate(d.getDate()+diff);return localYMD(d)}}
  return ymd;
}
function localYMD(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function titleCase(s){return String(s||'').trim().replace(/\b\w/g,c=>c.toUpperCase())}


// ---------------- IMPORTACIÓN EXCEL ----------------
function prepareImportPage(){ fillReferenceInputs(); }
function fileToBase64(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]||'');r.onerror=()=>reject(new Error('No pude leer el archivo'));r.readAsDataURL(file);});}
function importCategoryOptions(selected,type,counterparty=''){let cats=categoriesForProvider(type,counterparty);if(selected&&!cats.some(c=>c.name===selected)){const c=state.categories.find(x=>x.name===selected&&x.type===type);if(c)cats=[c,...cats]}return cats.map(c=>`<option value="${esc(c.name)}" ${c.name===selected?'selected':''}>${esc(c.name)}</option>`).join('')}
function importAccountOptions(selected){return '<option value="">Elegir cuenta…</option>'+state.accounts.map(a=>`<option value="${a._id}" ${a._id===selected?'selected':''}>${esc(a.name)}</option>`).join('')}
function importPaymentOptions(selected){const x=[['unspecified','Sin definir'],['cash','Efectivo'],['transfer','Transferencia'],['check','Cheque'],['echeck','Cheque electrónico / E-cheq']];return x.map(([v,t])=>`<option value="${v}" ${v===selected?'selected':''}>${t}</option>`).join('')}
function rowMissing(r){const out=[];if(isSalaryCategory(r.category)){if(!String(r.employeeName||'').trim())out.push('empleado')}else if(!String(r.counterparty||'').trim())out.push('proveedor/cliente');if(!r.category||!state.categories.some(c=>c.name===r.category&&c.type===r.type))out.push('categoría');if(!(Number(r.amount)>0))out.push('monto');if(!r.account)out.push('cuenta');if(!r.date||!r.dueDate)out.push('fecha');if(isCheckPayment(r.paymentMethod)&&!validCheckLast5(checkLast5(r.checkNumber)))out.push('últimos 5 del cheque');return out;}
function providerExists(name){const n=normalizeText(name||'');return !!n&&state.providers.some(p=>normalizeText(p.name)===n)}
function employeeExists(name){const n=normalizeText(name||'');return !!n&&state.employees.some(e=>normalizeText(e.name)===n)}
function renderImport(){
  const tbody=$('#importTable'); if(!tbody)return;
  tbody.innerHTML=state.importRows.map((r,i)=>{const missing=rowMissing(r),salary=isSalaryCategory(r.category);const newProvider=!salary&&r.counterparty&&!providerExists(r.counterparty);const newEmployee=salary&&r.employeeName&&!employeeExists(r.employeeName);return `<tr data-i="${i}" class="${missing.length?'import-invalid':''}">
    <td><span class="import-state ${missing.length?'warn':'ok'}">${missing.length?'⚠ '+esc(missing.join(', ')):'✓ Listo'}</span>${newProvider?'<small class="new-provider">Proveedor nuevo: se creará</small>':''}${newEmployee?'<small class="new-provider">Empleado nuevo: se creará</small>':''}</td>
    <td>${r.sourceRow||i+1}</td>
    <td><select data-field="type"><option value="expense" ${r.type==='expense'?'selected':''}>Egreso</option><option value="income" ${r.type==='income'?'selected':''}>Ingreso</option></select></td>
    <td><select data-field="status"><option value="pending" ${r.status==='pending'?'selected':''}>Pendiente</option><option value="paid" ${r.status==='paid'?'selected':''}>Pagado/Cobrado</option><option value="cancelled" ${r.status==='cancelled'?'selected':''}>Cancelado</option></select></td>
    <td>${salary?'<span class="muted">No aplica</span>':`<input data-field="counterparty" value="${esc(r.counterparty||'')}" list="providerNames">`}</td>
    <td>${salary?`<input data-field="employeeName" value="${esc(r.employeeName||r.counterparty||'')}" list="employeeNames" placeholder="Elegir o escribir empleado">`:'<span class="muted">—</span>'}</td>
    <td><select data-field="category"><option value="">Elegir…</option>${importCategoryOptions(r.category,r.type,r.counterparty)}</select></td>
    <td><input data-field="amount" type="number" min="0" step="0.01" value="${Number(r.amount)||''}"></td>
    <td><input data-field="date" type="date" value="${esc(r.date||'')}"></td>
    <td><input data-field="dueDate" type="date" value="${esc(r.dueDate||'')}"></td>
    <td><select data-field="paymentMethod">${importPaymentOptions(r.paymentMethod||'unspecified')}</select></td>
    <td>${isCheckPayment(r.paymentMethod)?`<input data-field="checkNumber" value="${esc(r.checkNumber||'')}" placeholder="12345" maxlength="5" inputmode="numeric">`:'<span class="muted">—</span>'}</td>
    <td><select data-field="account">${importAccountOptions(r.account||'')}</select></td>
    <td><button class="row-delete" data-remove="${i}" title="No importar esta fila">×</button></td></tr>`}).join('');
  const bad=state.importRows.filter(r=>rowMissing(r).length).length;const ready=state.importRows.length-bad;
  $('#importReadyText').textContent=`${ready} de ${state.importRows.length} movimientos listos${bad?` · ${bad} con datos faltantes`:''}`;
  $('#confirmImportBtn').disabled=!state.importRows.length||bad>0;
  if(state.importMeta)$('#importSummary').textContent=`Hoja “${state.importMeta.sheet}” · ${state.importRows.length} filas detectadas. Revisá todo antes de confirmar.`;
}
$('#previewImportBtn').onclick=async()=>{
  const f=$('#importFile').files?.[0];if(!f)return toast('Elegí un archivo Excel primero.',true);if(!/\.xlsx$/i.test(f.name))return toast('Por ahora usá un archivo .xlsx.',true);
  try{$('#previewImportBtn').disabled=true;$('#importInfo').textContent='Analizando el Excel…';const dataBase64=await fileToBase64(f);const r=await api('/api/import/excel/preview',{method:'POST',body:JSON.stringify({filename:f.name,dataBase64})});state.importRows=r.rows||[];state.importMeta=r;$('#importInfo').textContent=`${f.name} · hoja “${r.sheet}” · ${r.total} movimientos encontrados.`;$('#importReview').classList.remove('hidden');renderImport();}
  catch(e){toast(e.message,true);$('#importInfo').textContent='No se pudo analizar el archivo.';}finally{$('#previewImportBtn').disabled=false;}
};
$('#importTable').addEventListener('change',e=>{const tr=e.target.closest('tr[data-i]');if(!tr||!e.target.dataset.field)return;const i=Number(tr.dataset.i),f=e.target.dataset.field,r=state.importRows[i];r[f]=f==='amount'?Number(e.target.value):(f==='checkNumber'?checkLast5(e.target.value):e.target.value);if(f==='type'&&!state.categories.some(c=>c.name===r.category&&c.type===e.target.value))r.category='';if(f==='counterparty'){const p=providerByName(r.counterparty);if((p?.categories||[]).length===1)r.category=p.categories[0];}if(f==='category'&&!isSalaryCategory(r.category)){r.employee='';r.employeeName='';}renderImport();});
$('#importTable').addEventListener('click',e=>{const b=e.target.closest('[data-remove]');if(!b)return;state.importRows.splice(Number(b.dataset.remove),1);renderImport();});
$('#applyBulkBtn').onclick=()=>{const fields=[['type','#bulkType'],['status','#bulkStatus'],['category','#bulkCategory'],['paymentMethod','#bulkPayment'],['account','#bulkAccount']];for(const [field,sel] of fields){const v=$(sel).value;if(v)for(const r of state.importRows)r[field]=v;}renderImport();};
$('#confirmImportBtn').onclick=async()=>{const bad=state.importRows.filter(r=>rowMissing(r).length);if(bad.length)return toast('Todavía hay filas con datos faltantes.',true);if(!confirm(`¿Confirmar la importación de ${state.importRows.length} movimientos?`))return;try{$('#confirmImportBtn').disabled=true;const r=await api('/api/import/excel/commit',{method:'POST',body:JSON.stringify({rows:state.importRows})});toast(`Importados ${r.imported} movimientos · ${r.providersCreated} proveedores/clientes nuevos · ${r.employeesCreated||0} empleados nuevos`);state.importRows=[];state.importMeta=null;$('#importReview').classList.add('hidden');$('#importFile').value='';$('#importInfo').textContent='Importación completada correctamente.';await loadReference();}catch(e){toast(e.message,true);renderImport();}};



// ---------------- CARGA INICIAL MASIVA ----------------
function providerImportMissing(r){return !String(r.name||'').trim()||((r.unknownCategories||[]).length>0)}
function renderProviderImport(){
  const tb=$('#providerImportTable');if(!tb)return;tb.innerHTML=state.providerImportRows.map((r,i)=>`<tr class="${providerImportMissing(r)?'row-warning':''}"><td>${r.sourceRow||i+2}</td><td><input data-pif="name" data-i="${i}" value="${esc(r.name||'')}"></td><td><select data-pif="role" data-i="${i}"><option value="provider" ${r.role==='provider'?'selected':''}>Proveedor</option><option value="client" ${r.role==='client'?'selected':''}>Cliente</option><option value="both" ${r.role==='both'?'selected':''}>Ambos</option></select></td><td><input data-pif="categoriesText" data-i="${i}" value="${esc((r.categories||[]).join('; '))}" placeholder="Combustible; Repuestos"><small>${(r.unknownCategories||[]).length?'No reconocidas: '+esc(r.unknownCategories.join(', ')):''}</small></td><td><input data-pif="notes" data-i="${i}" value="${esc(r.notes||'')}"></td><td>${r.existing?'<span class="status pending">Ya existe · se actualizará</span>':'<span class="status paid">Nuevo</span>'}</td><td><button class="btn ghost" data-pi-remove="${i}">×</button></td></tr>`).join('');$('#providerImportCount').textContent=`${state.providerImportRows.length} filas para procesar`;$('#providerImportCommitBtn').disabled=!state.providerImportRows.length||state.providerImportRows.some(providerImportMissing);
}
$('#providerImportPreviewBtn').onclick=async()=>{const f=$('#providerImportFile').files?.[0];if(!f)return toast('Elegí el Excel de proveedores/clientes.',true);try{const dataBase64=await fileToBase64(f),r=await api('/api/import/providers/preview',{method:'POST',body:JSON.stringify({dataBase64})});state.providerImportRows=r.rows||[];$('#providerImportReview').classList.remove('hidden');$('#providerImportInfo').textContent=`${r.total} filas encontradas en ${r.sheet}. Revisalas antes de confirmar.`;renderProviderImport();}catch(e){toast(e.message,true)}};
$('#providerImportTable').addEventListener('change',e=>{const i=Number(e.target.dataset.i);if(!Number.isFinite(i)||!e.target.dataset.pif)return;const r=state.providerImportRows[i],f=e.target.dataset.pif;if(f==='categoriesText'){const parts=e.target.value.split(/[;,|]+/).map(x=>x.trim()).filter(Boolean);r.categories=[];r.unknownCategories=[];for(const p of parts){const c=state.categories.find(x=>normalizeText(x.name)===normalizeText(p)&&!isSalaryCategory(x.name));if(c)r.categories.push(c.name);else r.unknownCategories.push(p);}}else r[f]=e.target.value;renderProviderImport();});
$('#providerImportTable').addEventListener('click',e=>{const b=e.target.closest('[data-pi-remove]');if(!b)return;state.providerImportRows.splice(Number(b.dataset.piRemove),1);renderProviderImport();});
$('#providerImportCommitBtn').onclick=async()=>{if(state.providerImportRows.some(providerImportMissing))return toast('Hay filas con categorías no reconocidas o nombre faltante.',true);if(!confirm(`¿Importar ${state.providerImportRows.length} proveedores/clientes?`))return;try{const r=await api('/api/import/providers/commit',{method:'POST',body:JSON.stringify({rows:state.providerImportRows})});toast(`Proveedores/clientes: ${r.created} creados · ${r.updated} actualizados`);state.providerImportRows=[];$('#providerImportReview').classList.add('hidden');$('#providerImportFile').value='';await loadProviders();}catch(e){toast(e.message,true)}};

function renderEmployeeImport(){const tb=$('#employeeImportTable');if(!tb)return;tb.innerHTML=state.employeeImportRows.map((r,i)=>`<tr><td>${r.sourceRow||i+2}</td><td><input data-eif="name" data-i="${i}" value="${esc(r.name||'')}"></td><td><input data-eif="notes" data-i="${i}" value="${esc(r.notes||'')}"></td><td>${r.existing?'<span class="status pending">Ya existe</span>':'<span class="status paid">Nuevo</span>'}</td><td><button class="btn ghost" data-ei-remove="${i}">×</button></td></tr>`).join('');$('#employeeImportCount').textContent=`${state.employeeImportRows.length} filas para procesar`;$('#employeeImportCommitBtn').disabled=!state.employeeImportRows.length||state.employeeImportRows.some(r=>!String(r.name||'').trim());}
$('#employeeImportPreviewBtn').onclick=async()=>{const f=$('#employeeImportFile').files?.[0];if(!f)return toast('Elegí el Excel de empleados.',true);try{const dataBase64=await fileToBase64(f),r=await api('/api/import/employees/preview',{method:'POST',body:JSON.stringify({dataBase64})});state.employeeImportRows=r.rows||[];$('#employeeImportReview').classList.remove('hidden');$('#employeeImportInfo').textContent=`${r.total} empleados encontrados en ${r.sheet}. Revisalos antes de confirmar.`;renderEmployeeImport();}catch(e){toast(e.message,true)}};
$('#employeeImportTable').addEventListener('change',e=>{const i=Number(e.target.dataset.i);if(!Number.isFinite(i)||!e.target.dataset.eif)return;state.employeeImportRows[i][e.target.dataset.eif]=e.target.value;renderEmployeeImport();});
$('#employeeImportTable').addEventListener('click',e=>{const b=e.target.closest('[data-ei-remove]');if(!b)return;state.employeeImportRows.splice(Number(b.dataset.eiRemove),1);renderEmployeeImport();});
$('#employeeImportCommitBtn').onclick=async()=>{if(!confirm(`¿Importar ${state.employeeImportRows.length} empleados?`))return;try{const r=await api('/api/import/employees/commit',{method:'POST',body:JSON.stringify({rows:state.employeeImportRows})});toast(`Empleados: ${r.created} creados · ${r.updated} existentes actualizados`);state.employeeImportRows=[];$('#employeeImportReview').classList.add('hidden');$('#employeeImportFile').value='';await loadEmployees();}catch(e){toast(e.message,true)}};

// ---------------- CONTROL BANCARIO ----------------
function bankStatusText(s){return({controlled:'Controlado',linked:'Vinculado · falta tilde',suggested:'Coincidencia sugerida',ambiguous:'Revisar coincidencia',missing:'No encontrado en la app'})[s]||s}
function bankStatusClass(s){return s==='controlled'?'paid':(s==='missing'||s==='ambiguous'?'cancelled':'pending')}
function bankTxLabel(t){if(!t)return'';const date=t.dueDate||t.date||'';return `${fmtDate(date)} · ${t.counterparty} · ${money(t.amount)}${isCheckPayment(t.paymentMethod)&&t.checkNumber?' · Últ. 5: '+checkLast5(t.checkNumber):''}`}
async function loadBankImports(){
  state.bankImports=await api('/api/bank-reconciliation/imports');
  const sel=$('#bankBatch');if(!sel)return;
  const current=sel.value;sel.innerHTML=state.bankImports.length?state.bankImports.map(b=>`<option value="${b._id}">${esc(b.fileName)} · ${fmtDate(b.fromDate)} a ${fmtDate(b.toDate)}</option>`).join(''):'<option value="">Sin extractos</option>';
  if(current&&state.bankImports.some(x=>x._id===current))sel.value=current;
}
async function loadBankControl(){
  try{
    await loadBankImports();const batchId=$('#bankBatch')?.value||state.bankImports[0]?._id||'';
    if(!batchId){state.bankData=null;renderBankControl();return;}
    const p=new URLSearchParams({batchId,kind:state.bankKind});if($('#bankStatus')?.value)p.set('status',$('#bankStatus').value);
    state.bankData=await api('/api/bank-reconciliation?'+p.toString());renderBankControl();
  }catch(e){toast(e.message,true);}
}
function renderBankControl(){
  const d=state.bankData,s=d?.summary||{total:0,controlled:0,suggested:0,missing:0,appOnly:0};
  $('#bankTotal').textContent=s.total||0;$('#bankControlled').textContent=s.controlled||0;$('#bankSuggested').textContent=s.suggested||0;$('#bankMissing').textContent=s.missing||0;$('#bankAppOnlyCount').textContent=s.appOnly||0;
  $('#bankTableTitle').textContent=state.bankKind==='checks'?'Cheques / E-cheqs del banco':'Transferencias del banco';
  $('#bankAppOnlyTitle').textContent=state.bankKind==='checks'?'Cheques / E-cheqs cargados en la app sin coincidencia bancaria':'Transferencias cargadas en la app sin coincidencia bancaria';
  const tbody=$('#bankTable');if(!tbody)return;
  if(!d?.batch){tbody.innerHTML='<tr><td colspan="8" class="muted">Todavía no cargaste un extracto bancario.</td></tr>';$('#bankAppOnlyTable').innerHTML='';return;}
  tbody.innerHTML=(d.rows||[]).map(r=>{
    const selected=r.linkedTransaction?._id||r.suggestedTransaction?._id||'';
    const opts=(r.candidates||[]).slice();if(r.linkedTransaction&&!opts.some(x=>x._id===r.linkedTransaction._id))opts.unshift(r.linkedTransaction);if(r.suggestedTransaction&&!opts.some(x=>x._id===r.suggestedTransaction._id))opts.unshift(r.suggestedTransaction);
    const select=`<select class="bank-link-select" data-bank-id="${r._id}"><option value="">${r.matchStatus==='missing'?'No encontrado en la app':'Elegir movimiento…'}</option>${opts.map(t=>`<option value="${t._id}" ${t._id===selected?'selected':''}>${esc(bankTxLabel(t))}</option>`).join('')}</select>`;
    const canControl=!!selected;
    return `<tr class="${r.controlled?'controlled-row':''}"><td><label class="control-check"><input type="checkbox" data-bank-control="${r._id}" ${r.controlled?'checked':''} ${canControl?'':'disabled'}><span>${r.controlled?'Sí':'No'}</span></label></td><td>${fmtDate(r.date)}</td><td><strong>${esc(r.code)}</strong></td><td><strong>${esc(r.concept)}</strong><small class="bank-sub">${esc(r.info||r.channel||'')}</small></td><td>${r.checkNumber?`${esc(r.checkNumber)}<small class="bank-sub">Últ. 5: ${esc(checkLast5(r.checkNumber))}</small>`:'—'}</td><td class="amount ${r.direction||'expense'}">${r.direction==='income'?'+':'−'} ${money(r.amount)}</td><td>${select}</td><td><span class="status ${bankStatusClass(r.matchStatus)}">${bankStatusText(r.matchStatus)}</span></td></tr>`;
  }).join('')||'<tr><td colspan="8" class="muted">No hay movimientos para este filtro.</td></tr>';
  $('#bankAppOnlyTable').innerHTML=(d.appOnly||[]).map(t=>`<tr><td>${fmtDate(t.dueDate||t.date)}</td><td><strong>${esc(t.counterparty)}</strong></td><td>${esc(t.category)}</td><td class="amount ${t.type}">${money(t.amount)}</td><td>${esc(paymentText(t.paymentMethod))}</td><td>${esc(checkLast5(t.checkNumber)||'—')}</td><td><span class="status ${t.status}">${statusText(t.status)}</span></td></tr>`).join('')||'<tr><td colspan="7" class="muted">No hay movimientos de la app pendientes de conciliar en el período.</td></tr>';
  if($('#bankImportInfo')){const acc=state.accounts.find(a=>a._id===d.batch.accountId);$('#bankImportInfo').textContent=`${d.batch.fileName} · ${fmtDate(d.batch.fromDate)} a ${fmtDate(d.batch.toDate)} · ${acc?'Cuenta: '+acc.name+' · ':''}código 9: ${d.batch.checks||0} · código 990: ${d.batch.transfers||0}`;}
}
$('#bankImportBtn').onclick=async()=>{
  const f=$('#bankFile').files?.[0];if(!f)return toast('Elegí el archivo CSV del banco.',true);if(!/\.csv$/i.test(f.name))return toast('Para el control bancario usá el archivo .csv que entrega el banco.',true);
  try{$('#bankImportBtn').disabled=true;$('#bankImportInfo').textContent='Leyendo extracto bancario…';const dataBase64=await fileToBase64(f);const r=await api('/api/bank-reconciliation/import',{method:'POST',body:JSON.stringify({filename:f.name,dataBase64,accountId:$('#bankAccountSelect').value||null})});toast(r.duplicate?'Ese extracto ya estaba cargado. No se duplicó.':`Extracto cargado: ${r.counts.checks} cheques · ${r.counts.transfers} transferencias`);await loadBankImports();if(r.batch?._id)$('#bankBatch').value=r.batch._id;await loadBankControl();}
  catch(e){toast(e.message,true);$('#bankImportInfo').textContent='No se pudo cargar el extracto.';}finally{$('#bankImportBtn').disabled=false;}
};
$('#bankBatch').addEventListener('change',loadBankControl);$('#bankStatus').addEventListener('change',loadBankControl);
$$('.bank-kind').forEach(b=>b.onclick=()=>{state.bankKind=b.dataset.bankKind;$$('.bank-kind').forEach(x=>x.classList.toggle('active',x===b));loadBankControl();});
$('#bankDeleteBatchBtn').onclick=async()=>{const id=$('#bankBatch').value;if(!id)return;if(!confirm('¿Eliminar este extracto del módulo de control? Los movimientos financieros de la app no se borran.'))return;try{await api('/api/bank-reconciliation/imports/'+id,{method:'DELETE'});toast('Extracto eliminado');await loadBankControl();}catch(e){toast(e.message,true)}};
$('#bankTable').addEventListener('change',async e=>{
  if(e.target.matches('.bank-link-select')){const id=e.target.dataset.bankId;try{await api('/api/bank-reconciliation/'+id,{method:'PATCH',body:JSON.stringify({linkedTransactionId:e.target.value||null,controlled:false})});toast(e.target.value?'Movimiento vinculado':'Vínculo quitado');await loadBankControl();}catch(err){toast(err.message,true);await loadBankControl();}return;}
  if(e.target.matches('[data-bank-control]')){const id=e.target.dataset.bankControl,checked=e.target.checked,row=state.bankData?.rows?.find(x=>x._id===id),linked=row?.linkedTransaction?._id||row?.suggestedTransaction?._id||'';try{await api('/api/bank-reconciliation/'+id,{method:'PATCH',body:JSON.stringify({linkedTransactionId:linked||null,controlled:checked})});toast(checked?'Movimiento conciliado y controlado':'Control quitado');await loadBankControl();}catch(err){toast(err.message,true);await loadBankControl();}}
});


async function loadStorageStatus(){
  const el=$('#storageStatus'); if(!el)return;
  try{const s=await api('/api/storage/status');el.textContent=`MongoDB conectado · Base: ${s.database}${s.updatedAt?' · Último cambio: '+new Date(s.updatedAt).toLocaleString('es-AR'):''}`;}
  catch(e){el.textContent='No pude comprobar la conexión con MongoDB.';}
}
const backupBtn=$('#backupBtn');
if(backupBtn) backupBtn.onclick=()=>{window.location='/api/reports/backup-json';};

boot();
