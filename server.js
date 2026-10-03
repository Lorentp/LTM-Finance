require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const auth = require('./middleware/auth');
const store = require('./lib/store');
const { todayAR, addMonths } = require('./utils/date');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit:'8mb' }));
app.use(express.urlencoded({ extended:true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));
app.use('/api', async (req,res,next)=>{
  try{ await store.init(); next(); }
  catch(e){ console.error('MongoDB init error:',e); res.status(500).json({error:'No se pudo conectar con MongoDB. Revisá MONGODB_URI en Vercel.'}); }
});

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'las3marias';
const JWT_SECRET = process.env.JWT_SECRET || 'cambiar-esta-clave-en-vercel';

const lower=s=>String(s||'').toLocaleLowerCase('es');
const byName=(a,b)=>String(a.name||'').localeCompare(String(b.name||''),'es');
const clone=x=>JSON.parse(JSON.stringify(x));
const normName=v=>String(v||'').trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const isSalaryCategory=v=>normName(v).includes('sueldo');
const isCheckPayment=v=>['check','echeck'].includes(v);
function checkLast5(v,{pad=false}={}){const d=String(v??'').replace(/\D/g,'');if(!d)return'';const x=d.slice(-5);return pad?x.padStart(5,'0'):x;}
function validCheckLast5(v){return /^\d{5}$/.test(String(v||''));}

function populateAccount(tx,accounts){
  const t=clone(tx); const a=accounts.find(x=>x._id===t.account); t.account=a?{_id:a._id,name:a.name}:null; return t;
}
async function normalizeTxBody(body, employees=null){
  const date=body.date||todayAR();
  const category=String(body.category||'').trim();
  const paymentMethod=body.paymentMethod||'unspecified';
  let employee=body.employee||null;
  let counterparty=String(body.counterparty||'').trim();
  if(isSalaryCategory(category)){
    const list=employees||await store.list('employees');
    const emp=employee?list.find(x=>x._id===employee):null;
    if(emp) counterparty=emp.name;
  }else employee=null;
  return {
    type:body.type, counterparty, category, employee,
    amount:Math.abs(Number(body.amount)), date, dueDate:body.dueDate||date,
    status:body.status||'pending', account:body.account||null,
    paymentMethod, checkNumber:isCheckPayment(paymentMethod)?checkLast5(body.checkNumber):'',
    notes:String(body.notes||'').trim(), source:body.source||'manual',
    paidAt:body.status==='paid'?(body.paidAt||date):'',
    controlled:Boolean(body.controlled), controlledAt:body.controlled?(body.controlledAt||new Date().toISOString()):''
  };
}
function validateTx(tx){
  if(!['income','expense'].includes(tx.type)) throw new Error('Tipo inválido');
  if(isSalaryCategory(tx.category)&&!tx.employee) throw new Error('Falta empleado para el sueldo');
  if(!tx.counterparty) throw new Error(isSalaryCategory(tx.category)?'Falta empleado':'Falta cliente/proveedor');
  if(!tx.category) throw new Error('Falta categoría');
  if(!(tx.amount>0)) throw new Error('El monto debe ser mayor a 0');
  if(!tx.account) throw new Error('Falta cuenta de salida / entrada');
  if(!['unspecified','cash','transfer','check','echeck'].includes(tx.paymentMethod||'unspecified')) throw new Error('Medio de pago inválido');
  if(isCheckPayment(tx.paymentMethod)&&!validCheckLast5(tx.checkNumber)) throw new Error('El cheque / E-cheq debe tener exactamente los últimos 5 dígitos');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(tx.date)||!/^\d{4}-\d{2}-\d{2}$/.test(tx.dueDate)) throw new Error('Fecha inválida');
}
async function cleanProviderCategories(values){
  const arr=Array.isArray(values)?values:(values?[values]:[]);
  const cats=await store.list('categories');
  const valid=new Set(cats.filter(c=>c.active!==false&&!isSalaryCategory(c.name)).map(c=>c.name));
  return [...new Set(arr.map(String).map(x=>x.trim()).filter(x=>valid.has(x)))];
}
async function rememberProviderCategory(name,category,providers=null){
  if(!name||!category||isSalaryCategory(category))return;
  const list=providers||await store.list('providers');
  const p=list.find(x=>lower(x.name)===lower(name));
  if(!p)return;
  const cats=[...new Set([...(Array.isArray(p.categories)?p.categories:[]),category])];
  if(cats.length!==(p.categories||[]).length)await store.update('providers',p._id,{categories:cats,defaultCategory:cats[0]||''});
}
async function rememberProviderRole(name,type,providers=null){
  if(!name||!['income','expense'].includes(type))return;
  const list=providers||await store.list('providers'),p=list.find(x=>lower(x.name)===lower(name));if(!p)return;
  const target=type==='income'?'client':'provider',current=p.role||target,next=current===target?current:'both';if(next!==p.role)await store.update('providers',p._id,{role:next});
}
async function accountBalances(){
  const [txs,accounts]=await Promise.all([store.list('transactions'),store.list('accounts')]);
  return accounts.filter(x=>x.active!==false).sort(byName).map(a=>{
    let income=0,expense=0;
    for(const t of txs){if(t.status==='paid'&&t.account===a._id){if(t.type==='income')income+=Number(t.amount||0);else expense+=Number(t.amount||0);}}
    return {...a,currentBalance:Number(a.openingBalance||0)+income-expense};
  });
}

app.get('/api/health',async(req,res)=>{
  try{res.json({ok:true,app:'Las Tres Marías Finanzas',storage:await store.status()});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/auth/login',(req,res)=>{
  const {username,password}=req.body;
  if(username!==ADMIN_USER||password!==ADMIN_PASSWORD) return res.status(401).json({error:'Usuario o contraseña incorrectos'});
  const token=jwt.sign({username},JWT_SECRET,{expiresIn:'14d'});
  const cookieOptions={httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production'||!!process.env.VERCEL,path:'/'};
  res.cookie('ltm_token',token,{...cookieOptions,maxAge:14*24*60*60*1000});
  res.json({ok:true,username});
});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('ltm_token',{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production'||!!process.env.VERCEL,path:'/'});res.json({ok:true});});
app.get('/api/auth/me',auth,(req,res)=>res.json({ok:true,user:req.user}));

app.get('/api/storage/status',auth,async(req,res)=>{try{res.json(await store.status());}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/reports/backup-json',auth,async(req,res)=>{
  try{
    const data=await store.exportAll();
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="Las_Tres_Marias_Backup_${todayAR()}.json"`);
    res.send(JSON.stringify(data,null,2));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/categories',auth,async(req,res)=>res.json((await store.list('categories')).filter(x=>x.active!==false).sort((a,b)=>a.type.localeCompare(b.type)||byName(a,b))));
app.post('/api/categories',auth,async(req,res)=>{
  try{
    const name=String(req.body.name||'').trim();if(!name)throw new Error('Falta nombre');
    const cats=await store.list('categories');if(cats.some(x=>lower(x.name)===lower(name)))throw new Error('La categoría ya existe');
    res.json(await store.create('categories',{name,type:req.body.type||'expense',active:true}));
  }catch(e){res.status(400).json({error:e.message});}
});
app.put('/api/categories/:id',auth,async(req,res)=>{const item=await store.update('categories',req.params.id,req.body);if(!item)return res.status(404).json({error:'No encontrada'});res.json(item);});

app.get('/api/providers',auth,async(req,res)=>res.json((await store.list('providers')).filter(x=>x.active!==false).sort(byName)));
app.post('/api/providers',auth,async(req,res)=>{
  try{
    const name=String(req.body.name||'').trim();if(!name)throw new Error('Falta nombre');
    const providers=await store.list('providers');if(providers.some(x=>lower(x.name)===lower(name)))throw new Error('El proveedor/cliente ya existe');
    const categories=await cleanProviderCategories(req.body.categories);
    res.json(await store.create('providers',{name,role:['provider','client','both'].includes(req.body.role)?req.body.role:'provider',categories,defaultCategory:categories[0]||'',notes:String(req.body.notes||''),active:true}));
  }catch(e){res.status(400).json({error:e.message});}
});
app.put('/api/providers/:id',auth,async(req,res)=>{
  const patch={...req.body};if('categories' in patch){patch.categories=await cleanProviderCategories(patch.categories);patch.defaultCategory=patch.categories[0]||'';}
  const item=await store.update('providers',req.params.id,patch);if(!item)return res.status(404).json({error:'No encontrado'});res.json(item);
});

app.get('/api/employees',auth,async(req,res)=>res.json((await store.list('employees')).filter(x=>x.active!==false).sort(byName)));
app.post('/api/employees',auth,async(req,res)=>{
  try{const name=String(req.body.name||'').trim();if(!name)throw new Error('Falta nombre');const employees=await store.list('employees');if(employees.some(x=>lower(x.name)===lower(name)))throw new Error('El empleado ya existe');res.json(await store.create('employees',{name,notes:String(req.body.notes||''),active:true}));}catch(e){res.status(400).json({error:e.message});}
});
app.put('/api/employees/:id',auth,async(req,res)=>{const item=await store.update('employees',req.params.id,{name:String(req.body.name||'').trim(),notes:String(req.body.notes||'')});if(!item)return res.status(404).json({error:'No encontrado'});res.json(item);});


// ---------------- CARGA INICIAL DE PROVEEDORES / EMPLEADOS ----------------
function simpleCell(v){if(v==null)return'';if(v instanceof Date)return v.toISOString();if(typeof v==='object'){if(v.text!=null)return v.text;if(v.result!=null)return v.result;if(Array.isArray(v.richText))return v.richText.map(x=>x.text||'').join('');}return v;}
async function loadSimpleWorkbook(dataBase64){const b64=String(dataBase64||'');if(!b64)throw new Error('No recibí el archivo Excel');const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(b64,'base64'));const ws=wb.worksheets[0];if(!ws)throw new Error('El Excel no tiene hojas');return ws;}
function simpleHeaders(ws){const out={};ws.getRow(1).eachCell({includeEmpty:false},(c,col)=>{out[normName(simpleCell(c.value)).replace(/[^a-z0-9]+/g,' ')]=col;});return out;}
function colBy(headers,...names){for(const n of names){const key=normName(n).replace(/[^a-z0-9]+/g,' ');if(headers[key])return headers[key];}return 0;}
function roleCode(v){const n=normName(v);if(n.includes('amb'))return'both';if(n.includes('client'))return'client';return'provider';}
function roleText(v){return v==='client'?'Cliente':v==='both'?'Proveedor y cliente':'Proveedor';}
function parseCatsText(v,categories){const parts=String(v||'').split(/[;,|]+/).map(x=>x.trim()).filter(Boolean),found=[],unknown=[];for(const p of parts){const c=categories.find(x=>normName(x.name)===normName(p)&&!isSalaryCategory(x.name));if(c)found.push(c.name);else unknown.push(p);}return{categories:[...new Set(found)],unknown:[...new Set(unknown)]};}
app.post('/api/import/providers/preview',auth,async(req,res)=>{
  try{const ws=await loadSimpleWorkbook(req.body.dataBase64),h=simpleHeaders(ws),nameCol=colBy(h,'nombre','proveedor cliente','razon social'),roleCol=colBy(h,'tipo','rol'),catsCol=colBy(h,'categorias','categoria'),notesCol=colBy(h,'notas','observaciones');if(!nameCol)throw new Error('La plantilla debe tener una columna Nombre');const [providers,categories]=await Promise.all([store.list('providers'),store.list('categories')]);const rows=[];
    for(let r=2;r<=ws.rowCount;r++){const name=String(simpleCell(ws.getRow(r).getCell(nameCol).value)||'').trim();if(!name)continue;const existing=providers.find(x=>normName(x.name)===normName(name)),pc=parseCatsText(catsCol?simpleCell(ws.getRow(r).getCell(catsCol).value):'',categories);rows.push({sourceRow:r,name,role:roleCode(roleCol?simpleCell(ws.getRow(r).getCell(roleCol).value):''),categories:pc.categories,unknownCategories:pc.unknown,notes:String(notesCol?simpleCell(ws.getRow(r).getCell(notesCol).value):'').trim(),existingId:existing?._id||'',existing:!!existing});}
    res.json({ok:true,sheet:ws.name,total:rows.length,rows});
  }catch(e){res.status(400).json({error:'No pude leer proveedores/clientes: '+e.message});}
});
app.post('/api/import/providers/commit',auth,async(req,res)=>{
  try{const rows=Array.isArray(req.body.rows)?req.body.rows:[];if(!rows.length)throw new Error('No hay filas para importar');let providers=await store.list('providers'),created=0,updated=0,skipped=0;
    for(const r of rows){const name=String(r.name||'').trim();if(!name){skipped++;continue;}const categories=await cleanProviderCategories(r.categories||[]);let p=providers.find(x=>normName(x.name)===normName(name));if(p){const merged=[...new Set([...(p.categories||[]),...categories])];await store.update('providers',p._id,{name,role:['provider','client','both'].includes(r.role)?r.role:(p.role||'provider'),categories:merged,defaultCategory:merged[0]||'',notes:String(r.notes||p.notes||'')});updated++;}else{p=await store.create('providers',{name,role:['provider','client','both'].includes(r.role)?r.role:'provider',categories,defaultCategory:categories[0]||'',notes:String(r.notes||''),active:true});providers.push(p);created++;}}
    res.json({ok:true,created,updated,skipped});
  }catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/import/employees/preview',auth,async(req,res)=>{
  try{const ws=await loadSimpleWorkbook(req.body.dataBase64),h=simpleHeaders(ws),nameCol=colBy(h,'nombre','empleado'),notesCol=colBy(h,'notas','observaciones');if(!nameCol)throw new Error('La plantilla debe tener una columna Nombre');const employees=await store.list('employees'),rows=[];for(let r=2;r<=ws.rowCount;r++){const name=String(simpleCell(ws.getRow(r).getCell(nameCol).value)||'').trim();if(!name)continue;const existing=employees.find(x=>normName(x.name)===normName(name));rows.push({sourceRow:r,name,notes:String(notesCol?simpleCell(ws.getRow(r).getCell(notesCol).value):'').trim(),existingId:existing?._id||'',existing:!!existing});}res.json({ok:true,sheet:ws.name,total:rows.length,rows});}
  catch(e){res.status(400).json({error:'No pude leer empleados: '+e.message});}
});
app.post('/api/import/employees/commit',auth,async(req,res)=>{
  try{const rows=Array.isArray(req.body.rows)?req.body.rows:[];if(!rows.length)throw new Error('No hay filas para importar');let employees=await store.list('employees'),created=0,updated=0,skipped=0;for(const r of rows){const name=String(r.name||'').trim();if(!name){skipped++;continue;}let e=employees.find(x=>normName(x.name)===normName(name));if(e){if(String(r.notes||'').trim())await store.update('employees',e._id,{name,notes:String(r.notes).trim()});updated++;}else{e=await store.create('employees',{name,notes:String(r.notes||''),active:true});employees.push(e);created++;}}res.json({ok:true,created,updated,skipped});}
  catch(e){res.status(400).json({error:e.message});}
});

app.get('/api/accounts',auth,async(req,res)=>res.json(await accountBalances()));
app.post('/api/accounts',auth,async(req,res)=>{
  try{const name=String(req.body.name||'').trim();if(!name)throw new Error('Falta nombre');res.json(await store.create('accounts',{name,type:req.body.type||'bank',openingBalance:Number(req.body.openingBalance||0),active:true}));}catch(e){res.status(400).json({error:e.message});}
});
app.put('/api/accounts/:id',auth,async(req,res)=>{
  const patch={...req.body};if(patch.openingBalance!==undefined)patch.openingBalance=Number(patch.openingBalance);
  const item=await store.update('accounts',req.params.id,patch);if(!item)return res.status(404).json({error:'No encontrada'});res.json(item);
});

app.get('/api/transactions',auth,async(req,res)=>{
  let [txs,accounts]=await Promise.all([store.list('transactions'),store.list('accounts')]);
  if(req.query.includeInternal!=='true')txs=txs.filter(x=>!x.isInternalTransfer);
  if(req.query.type)txs=txs.filter(x=>x.type===req.query.type);
  if(req.query.status)txs=txs.filter(x=>x.status===req.query.status);
  if(req.query.category)txs=txs.filter(x=>x.category===req.query.category);
  if(req.query.paymentMethod)txs=txs.filter(x=>(x.paymentMethod||'unspecified')===req.query.paymentMethod);
  if(req.query.controlled==='true')txs=txs.filter(x=>x.controlled===true);
  if(req.query.controlled==='false')txs=txs.filter(x=>x.controlled!==true);
  if(req.query.from)txs=txs.filter(x=>x.dueDate>=req.query.from);
  if(req.query.to)txs=txs.filter(x=>x.dueDate<=req.query.to);
  if(req.query.search){const q=lower(req.query.search);txs=txs.filter(x=>lower(x.counterparty).includes(q)||lower(x.category).includes(q)||lower(x.notes).includes(q)||lower(x.checkNumber).includes(q));}
  txs.sort((a,b)=>(b.dueDate||'').localeCompare(a.dueDate||'')||(b.createdAt||'').localeCompare(a.createdAt||''));
  txs=txs.slice(0,Math.min(Number(req.query.limit)||500,2000)).map(t=>populateAccount(t,accounts));
  res.json(txs);
});
app.post('/api/transactions',auth,async(req,res)=>{
  try{
    const [employees,accounts,providers]=await Promise.all([store.list('employees'),store.list('accounts'),store.list('providers')]);
    const tx=await normalizeTxBody(req.body,employees);validateTx(tx);
    if(!accounts.some(a=>a._id===tx.account&&a.active!==false))throw new Error('La cuenta seleccionada no existe');
    let existing=null;
    if(!isSalaryCategory(tx.category)){
      existing=providers.find(p=>lower(p.name)===lower(tx.counterparty)&&p.active!==false);
      if(!existing)throw new Error(`El ${tx.type==='income'?'cliente':'proveedor'} “${tx.counterparty}” no está cargado. Crealo desde el aviso del movimiento y volvé a confirmar.`);
    }
    const saved=await store.create('transactions',tx);
    if(existing){await rememberProviderCategory(tx.counterparty,tx.category,providers);await rememberProviderRole(tx.counterparty,tx.type,providers);}
    res.json(saved);
  }catch(e){res.status(400).json({error:e.message});}
});
app.put('/api/transactions/:id',auth,async(req,res)=>{
  try{
    const current=await store.find('transactions',req.params.id);if(!current)return res.status(404).json({error:'No encontrado'});
    const [employees,accounts,providers]=await Promise.all([store.list('employees'),store.list('accounts'),store.list('providers')]);
    const patch={...req.body};if(patch.amount!==undefined)patch.amount=Math.abs(Number(patch.amount));if(patch.status==='paid'&&!patch.paidAt)patch.paidAt=patch.date||todayAR();
    const candidate=await normalizeTxBody({...current,...patch},employees);validateTx(candidate);
    if(!accounts.some(a=>a._id===candidate.account&&a.active!==false))throw new Error('La cuenta seleccionada no existe');
    if(!isSalaryCategory(candidate.category)&&!providers.some(p=>lower(p.name)===lower(candidate.counterparty)&&p.active!==false))throw new Error(`El ${candidate.type==='income'?'cliente':'proveedor'} “${candidate.counterparty}” no está cargado. Crealo desde el aviso del movimiento y volvé a confirmar.`);
    const saved=await store.update('transactions',req.params.id,candidate);
    if(!isSalaryCategory(candidate.category)){await rememberProviderCategory(candidate.counterparty,candidate.category,providers);await rememberProviderRole(candidate.counterparty,candidate.type,providers);}
    res.json(populateAccount(saved,accounts));
  }catch(e){res.status(400).json({error:e.message});}
});
app.patch('/api/transactions/:id/controlled',auth,async(req,res)=>{
  try{
    const value=!!req.body.controlled;
    const item=await store.update('transactions',req.params.id,{controlled:value,controlledAt:value?new Date().toISOString():'',controlledBy:value?(req.user?.username||ADMIN_USER):''});
    if(!item)return res.status(404).json({error:'No encontrado'});
    res.json({ok:true,controlled:item.controlled,controlledAt:item.controlledAt});
  }catch(e){res.status(400).json({error:e.message});}
});
app.delete('/api/transactions/:id',auth,async(req,res)=>{if(!await store.remove('transactions',req.params.id))return res.status(404).json({error:'No encontrado'});res.json({ok:true});});
app.post('/api/transactions/:id/mark-paid',auth,async(req,res)=>{
  const item=await store.update('transactions',req.params.id,{status:'paid',account:req.body.account||null,paidAt:req.body.paidAt||todayAR()});if(!item)return res.status(404).json({error:'No encontrado'});const accounts=await store.list('accounts');res.json(populateAccount(item,accounts));
});

// ---------------- MOVIMIENTOS ENTRE CUENTAS PROPIAS ----------------
function transferGroupView(rows,accounts){
  const map=new Map(accounts.map(a=>[a._id,a]));
  const groups=new Map();
  for(const t of rows.filter(x=>x.isInternalTransfer&&x.internalTransferId)){
    if(!groups.has(t.internalTransferId))groups.set(t.internalTransferId,[]);
    groups.get(t.internalTransferId).push(t);
  }
  return [...groups].map(([id,pair])=>{
    const from=pair.find(x=>x.transferSide==='from'||x.type==='expense'),to=pair.find(x=>x.transferSide==='to'||x.type==='income');
    return {_id:id,date:from?.date||to?.date||'',amount:Number(from?.amount||to?.amount||0),status:from?.status||to?.status||'pending',notes:from?.notes||to?.notes||'',
      fromAccount:from?{_id:from.account,name:map.get(from.account)?.name||'Cuenta'}:null,toAccount:to?{_id:to.account,name:map.get(to.account)?.name||'Cuenta'}:null,
      fromControlled:!!from?.controlled,toControlled:!!to?.controlled,fromTransactionId:from?._id||'',toTransactionId:to?._id||''};
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
}
app.get('/api/internal-transfers',auth,async(req,res)=>{
  const [txs,accounts]=await Promise.all([store.list('transactions'),store.list('accounts')]);
  res.json(transferGroupView(txs,accounts));
});
app.post('/api/internal-transfers',auth,async(req,res)=>{
  try{
    const fromAccount=String(req.body.fromAccount||''),toAccount=String(req.body.toAccount||''),amount=Math.abs(Number(req.body.amount||0)),date=String(req.body.date||todayAR()),status=String(req.body.status||'paid'),notes=String(req.body.notes||'').trim();
    if(!fromAccount||!toAccount)throw new Error('Elegí la cuenta de origen y la cuenta de destino');
    if(fromAccount===toAccount)throw new Error('La cuenta de origen y destino no pueden ser la misma');
    if(!(amount>0))throw new Error('El monto debe ser mayor a 0');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Fecha inválida');
    if(!['pending','paid','cancelled'].includes(status))throw new Error('Estado inválido');
    const accounts=await store.list('accounts'),from=accounts.find(a=>a._id===fromAccount&&a.active!==false),to=accounts.find(a=>a._id===toAccount&&a.active!==false);
    if(!from||!to)throw new Error('Una de las cuentas seleccionadas no existe');
    const group=crypto.randomUUID(),common={amount,date,dueDate:date,status,paymentMethod:'transfer',checkNumber:'',notes,source:'internal_transfer',isInternalTransfer:true,internalTransferId:group,paidAt:status==='paid'?date:'',controlled:false,controlledAt:''};
    await store.createMany('transactions',[
      {...common,type:'expense',account:from._id,counterparty:`Cuenta propia: ${to.name}`,category:'Movimiento entre cuentas propias',employee:null,transferSide:'from',pairedAccount:to._id},
      {...common,type:'income',account:to._id,counterparty:`Cuenta propia: ${from.name}`,category:'Movimiento entre cuentas propias',employee:null,transferSide:'to',pairedAccount:from._id}
    ]);
    res.json({ok:true,_id:group});
  }catch(e){res.status(400).json({error:e.message});}
});
app.put('/api/internal-transfers/:id',auth,async(req,res)=>{
  try{
    const rows=(await store.list('transactions',{internalTransferId:req.params.id})).filter(x=>x.isInternalTransfer);if(rows.length!==2)throw new Error('Transferencia propia no encontrada');
    const fromAccount=String(req.body.fromAccount||''),toAccount=String(req.body.toAccount||''),amount=Math.abs(Number(req.body.amount||0)),date=String(req.body.date||todayAR()),status=String(req.body.status||'paid'),notes=String(req.body.notes||'').trim();
    if(!fromAccount||!toAccount||fromAccount===toAccount)throw new Error('Revisá las cuentas de origen y destino');if(!(amount>0))throw new Error('El monto debe ser mayor a 0');
    const accounts=await store.list('accounts'),from=accounts.find(a=>a._id===fromAccount&&a.active!==false),to=accounts.find(a=>a._id===toAccount&&a.active!==false);if(!from||!to)throw new Error('Una de las cuentas seleccionadas no existe');
    const out=rows.find(x=>x.transferSide==='from'||x.type==='expense'),inc=rows.find(x=>x.transferSide==='to'||x.type==='income'),base={amount,date,dueDate:date,status,notes,paidAt:status==='paid'?date:''};
    await store.update('transactions',out._id,{...base,type:'expense',account:from._id,counterparty:`Cuenta propia: ${to.name}`,pairedAccount:to._id});
    await store.update('transactions',inc._id,{...base,type:'income',account:to._id,counterparty:`Cuenta propia: ${from.name}`,pairedAccount:from._id});
    res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message});}
});
app.delete('/api/internal-transfers/:id',auth,async(req,res)=>{const n=await store.removeMany('transactions',{internalTransferId:req.params.id,isInternalTransfer:true});if(!n)return res.status(404).json({error:'Transferencia no encontrada'});res.json({ok:true,deleted:n});});

app.post('/api/installments',auth,async(req,res)=>{
  try{
    const {type='expense',counterparty,category,totalAmount,count,firstDueDate,account=null,paymentMethod='unspecified',notes=''}=req.body;
    const n=Number(count),total=Math.abs(Number(totalAmount));
    if(!counterparty||!category||!(total>0)||!(n>=2&&n<=120)||!firstDueDate||!account)throw new Error('Datos de cuotas incompletos: incluí la cuenta de salida');
    const accounts=await store.list('accounts');if(!accounts.some(a=>a._id===account&&a.active!==false))throw new Error('La cuenta seleccionada no existe');
    const rawChecks=(Array.isArray(req.body.checkNumbers)?req.body.checkNumbers:String(req.body.checkNumbers||'').split(/[,;\n]+/)).map(x=>checkLast5(x)).filter(Boolean);
    if(isCheckPayment(paymentMethod)&&rawChecks.length!==n)throw new Error(`Para ${paymentMethod==='echeck'?'E-cheq':'cheque'} cargá ${n} números, uno por cuota`);
    if(isCheckPayment(paymentMethod)&&rawChecks.some(x=>!validCheckLast5(x)))throw new Error('Cada cheque / E-cheq debe tener exactamente los últimos 5 dígitos');
    const group=crypto.randomUUID(),base=Math.round((total/n)*100)/100,docs=[];
    for(let i=0;i<n;i++){
      const amount=i===n-1?Math.round((total-base*(n-1))*100)/100:base;
      docs.push({type,counterparty,category,amount,date:todayAR(),dueDate:addMonths(firstDueDate,i),status:'pending',account,paymentMethod,checkNumber:isCheckPayment(paymentMethod)?rawChecks[i]:'',notes,source:'installment',installmentGroup:group,installmentNumber:i+1,installmentCount:n,paidAt:'',controlled:false,controlledAt:''});
    }
    const providers=await store.list('providers');const ep=providers.find(p=>lower(p.name)===lower(counterparty)&&p.active!==false);
    if(!ep)throw new Error(`El proveedor “${counterparty}” no está cargado. Crealo desde el aviso de la compra en cuotas y volvé a confirmar.`);
    await rememberProviderCategory(counterparty,category,providers);await rememberProviderRole(counterparty,'expense',providers);
    const saved=await store.createMany('transactions',docs);res.json({ok:true,count:saved.length,group});
  }catch(e){res.status(400).json({error:e.message});}
});

// ---------------- IMPORTACIÓN EXCEL ----------------
const norm = v => String(v ?? '').trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const IMPORT_ALIASES = {
  date:['fecha','fecha operacion','fecha movimiento','fecha comprobante'],
  dueDate:['vencimiento','fecha vencimiento','fecha de vencimiento','fecha pago','fecha de pago','fecha cobro','fecha de cobro'],
  counterparty:['proveedor','cliente','proveedor cliente','cliente proveedor','razon social','beneficiario','destinatario','a quien','nombre'],
  employee:['empleado','empleada','personal','colaborador'],
  category:['categoria','rubro'], amount:['monto','importe','total','valor','pesos','importe total'],
  paymentMethod:['medio de pago','forma de pago','tipo de pago','pago'],
  checkNumber:['numero cheque','n cheque','nro cheque','numero de cheque','nro de cheque','cheque numero','numero e cheq','nro e cheq','numero echeq','nro echeq','ultimos 5 cheque','ultimos 5 cheque e cheq','ultimos 5 del cheque','ultimos 5 digitos cheque','ultimos 5 digitos del cheque'],
  account:['cuenta','cuenta origen','cuenta destino','cuenta bancaria','banco'], type:['tipo','tipo movimiento','movimiento','ingreso egreso'],
  status:['estado','situacion'], notes:['notas','nota','detalle','descripcion','concepto','observacion','observaciones']
};
function cellPrimitive(v){if(v==null)return'';if(v instanceof Date)return v;if(typeof v==='object'){if(v.result!=null)return cellPrimitive(v.result);if(v.text!=null)return cellPrimitive(v.text);if(Array.isArray(v.richText))return v.richText.map(x=>x.text||'').join('');}return v;}
function dateYMD(v){v=cellPrimitive(v);if(!v)return'';if(v instanceof Date){const y=v.getUTCFullYear(),m=v.getUTCMonth()+1,d=v.getUTCDate();return`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;}if(typeof v==='number'&&v>20000&&v<100000){const ms=Math.round((v-25569)*86400*1000),d=new Date(ms);return`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}const t=String(v).trim();let m=t.match(/^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)/);if(m)return`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;m=t.match(/^([0-3]?\d)[-\/]([01]?\d)[-\/](\d{2,4})/);if(m){let y=Number(m[3]);if(y<100)y+=2000;return`${y}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;}return'';}
function amountNumber(v){v=cellPrimitive(v);if(typeof v==='number')return Math.abs(v);let t=String(v||'').replace(/\$/g,'').replace(/\s/g,'');if(!t)return 0;if(t.includes('.')&&t.includes(','))t=t.replace(/\./g,'').replace(',','.');else if((t.match(/\./g)||[]).length>1||/\.\d{3}$/.test(t))t=t.replace(/\./g,'');else t=t.replace(',','.');const n=Number(t.replace(/[^0-9.-]/g,''));return Number.isFinite(n)?Math.abs(n):0;}
function paymentCode(v){const t=norm(cellPrimitive(v));if(!t)return'unspecified';if(/e cheq|echeq|cheque electronico/.test(t))return'echeck';if(/transfer/.test(t))return'transfer';if(/efectivo|cash/.test(t))return'cash';if(/cheque/.test(t))return'check';return'unspecified';}
function typeCode(v){const t=norm(cellPrimitive(v));if(/ingreso|cobro|venta|entrada/.test(t))return'income';if(/egreso|pago|gasto|salida/.test(t))return'expense';return'';}
function statusCode(v){const t=norm(cellPrimitive(v));if(/pagado|cobrado|realizado|hecho/.test(t))return'paid';if(/cancelado|anulado/.test(t))return'cancelled';if(/pendiente|a pagar|a cobrar/.test(t))return'pending';return'';}
function headerField(h){const n=norm(h);for(const [field,aliases] of Object.entries(IMPORT_ALIASES)){if(aliases.some(a=>n===norm(a)||n.includes(norm(a))))return field;}return'';}
function findHeaderRow(ws){let best={row:1,score:-1};for(let r=1;r<=Math.min(ws.rowCount,12);r++){let score=0;const seen=new Set();ws.getRow(r).eachCell({includeEmpty:false},c=>{const f=headerField(cellPrimitive(c.value));if(f&&!seen.has(f)){score++;seen.add(f);}});if(score>best.score)best={row:r,score};}return best.row;}
function mapHeaders(ws,rowNum){const map={},headers=[];ws.getRow(rowNum).eachCell({includeEmpty:true},(c,col)=>{const text=String(cellPrimitive(c.value)||'').trim();headers[col]=text;const f=headerField(text);if(f&&!map[f])map[f]=col;});return{map,headers};}
function getCell(ws,r,col){return col?cellPrimitive(ws.getRow(r).getCell(col).value):'';}
function matchAccount(name,accounts){const n=norm(name);if(!n)return null;return accounts.find(a=>norm(a.name)===n)||accounts.find(a=>n.includes(norm(a.name))||norm(a.name).includes(n))||null;}
function matchCategory(name,categories){const n=norm(name);if(!n)return'';return(categories.find(c=>norm(c.name)===n)||categories.find(c=>n.includes(norm(c.name))||norm(c.name).includes(n)))?.name||'';}
function matchProvider(name,providers){const n=norm(name);if(!n)return null;return providers.find(p=>norm(p.name)===n)||null;}
function matchEmployee(name,employees){const n=norm(name);if(!n)return null;return employees.find(p=>norm(p.name)===n)||null;}

app.post('/api/import/excel/preview',auth,async(req,res)=>{
  try{
    const b64=String(req.body.dataBase64||'');if(!b64)throw new Error('No recibí el archivo Excel');
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(b64,'base64'));const ws=wb.worksheets[0];if(!ws)throw new Error('El Excel no tiene hojas');
    const headerRow=findHeaderRow(ws),{map,headers}=mapHeaders(ws,headerRow);
    const [categories,providers,employees,accounts]=await Promise.all([store.list('categories'),store.list('providers'),store.list('employees'),store.list('accounts')]);const rows=[];
    for(let r=headerRow+1;r<=ws.rowCount;r++){
      const vals=[];ws.getRow(r).eachCell({includeEmpty:false},c=>vals.push(cellPrimitive(c.value)));if(!vals.some(v=>String(v??'').trim()))continue;
      const rawAmount=getCell(ws,r,map.amount);let type=typeCode(getCell(ws,r,map.type))||'expense';if(typeof rawAmount==='number'&&rawAmount<0)type='expense';
      let counterparty=String(getCell(ws,r,map.counterparty)||'').trim();const provider=matchProvider(counterparty,providers);
      let category=matchCategory(getCell(ws,r,map.category),categories);const providerCats=Array.isArray(provider?.categories)?provider.categories:[];if(!category&&providerCats.length===1)category=providerCats[0];
      const employeeName=String(getCell(ws,r,map.employee)||'').trim(),employee=matchEmployee(employeeName,employees);if(isSalaryCategory(category)&&employee)counterparty=employee.name;
      const date=dateYMD(getCell(ws,r,map.date))||todayAR(),dueDate=dateYMD(getCell(ws,r,map.dueDate))||date,account=matchAccount(getCell(ws,r,map.account),accounts),paymentMethod=paymentCode(getCell(ws,r,map.paymentMethod));
      const row={sourceRow:r,type,status:statusCode(getCell(ws,r,map.status))||'pending',counterparty,employee:employee?employee._id:'',employeeName,category,amount:amountNumber(rawAmount),date,dueDate,paymentMethod,checkNumber:isCheckPayment(paymentMethod)?checkLast5(getCell(ws,r,map.checkNumber),{pad:true}):'',account:account?account._id:'',notes:String(getCell(ws,r,map.notes)||'').trim(),providerExists:!!provider};
      row.missing=[];if(isSalaryCategory(row.category)){if(!row.employeeName)row.missing.push('empleado');}else if(!row.counterparty)row.missing.push('proveedor/cliente');if(!row.category)row.missing.push('categoría');if(!(row.amount>0))row.missing.push('monto');if(!row.account)row.missing.push('cuenta');if(!row.date||!row.dueDate)row.missing.push('fecha');if(isCheckPayment(row.paymentMethod)&&!validCheckLast5(row.checkNumber))row.missing.push('últimos 5 del cheque');rows.push(row);
    }
    res.json({ok:true,sheet:ws.name,headerRow,headers:headers.filter(Boolean),detected:map,total:rows.length,rows});
  }catch(e){res.status(400).json({error:'No pude leer el Excel: '+e.message});}
});

app.post('/api/import/excel/commit',auth,async(req,res)=>{
  try{
    const rows=Array.isArray(req.body.rows)?req.body.rows:[];if(!rows.length)throw new Error('No hay filas para importar');if(rows.length>3000)throw new Error('Máximo 3000 movimientos por importación');
    let [categories,providers,employees,accounts]=await Promise.all([store.list('categories'),store.list('providers'),store.list('employees'),store.list('accounts')]);
    const activeCats=categories.filter(c=>c.active!==false),activeAccounts=accounts.filter(a=>a.active!==false),empMap=new Map(employees.map(e=>[lower(e.name),e])),newEmpNames=[];
    for(const r of rows){if(isSalaryCategory(r.category)){const name=String(r.employeeName||'').trim();if(!name)throw new Error(`Fila ${r.sourceRow||'?'}: falta empleado`);if(!empMap.has(lower(name))&&!newEmpNames.some(x=>lower(x)===lower(name)))newEmpNames.push(name);}}
    let employeesCreated=0;if(newEmpNames.length){const created=await store.createMany('employees',newEmpNames.map(name=>({name,notes:'Creado automáticamente desde importación Excel',active:true})));employeesCreated=created.length;for(const e of created)empMap.set(lower(e.name),e);}
    const docs=[];
    for(let i=0;i<rows.length;i++){
      const r=rows[i],salary=isSalaryCategory(r.category),emp=salary?empMap.get(lower(r.employeeName||'')):null;
      const tx=await normalizeTxBody({...r,employee:emp?emp._id:null,counterparty:salary?(emp?.name||''):r.counterparty,source:'excel'},employees);validateTx(tx);
      if(!activeCats.some(c=>c.name===tx.category&&c.type===tx.type))throw new Error(`Fila ${r.sourceRow||i+1}: categoría inválida para el tipo de movimiento`);
      if(!tx.account||!activeAccounts.some(a=>a._id===tx.account))throw new Error(`Fila ${r.sourceRow||i+1}: falta una cuenta válida de salida/entrada`);
      docs.push({...tx,importSourceRow:r.sourceRow||null,controlled:false,controlledAt:''});
    }
    const newProviders=[],known=new Set(providers.map(p=>lower(p.name))),catsByProvider=new Map();
    for(const tx of docs.filter(x=>!isSalaryCategory(x.category))){const k=lower(tx.counterparty);if(!catsByProvider.has(k))catsByProvider.set(k,new Set());catsByProvider.get(k).add(tx.category);if(!known.has(k)){known.add(k);newProviders.push(tx.counterparty);}}
    let providersCreated=0;if(newProviders.length){const created=await store.createMany('providers',newProviders.map(name=>{const cats=[...(catsByProvider.get(lower(name))||[])],types=[...new Set(docs.filter(x=>lower(x.counterparty)===lower(name)).map(x=>x.type))],role=types.length>1?'both':(types[0]==='income'?'client':'provider');return{name,role,categories:cats,defaultCategory:cats[0]||'',notes:'Creado automáticamente desde importación Excel',active:true};}));providersCreated=created.length;providers=[...providers,...created];}
    for(const [k,cats] of catsByProvider){const p=providers.find(x=>lower(x.name)===k);if(p){const merged=[...new Set([...(p.categories||[]),...cats])];if(merged.length!==(p.categories||[]).length)await store.update('providers',p._id,{categories:merged,defaultCategory:merged[0]||''});}}
    const saved=await store.createMany('transactions',docs);res.json({ok:true,imported:saved.length,providersCreated,employeesCreated});
  }catch(e){res.status(400).json({error:e.message});}
});


// ---------------- CONTROL / CONCILIACIÓN BANCARIA ----------------
function csvSplitLine(line){
  const out=[];let cur='',quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(quoted&&line[i+1]==='"'){cur+='"';i++;}
      else quoted=!quoted;
    }else if(ch===';'&&!quoted){out.push(cur);cur='';}
    else cur+=ch;
  }
  out.push(cur);return out.map(x=>x.trim());
}
function parseBankCsvBuffer(buffer){
  let text=buffer.toString('utf8').replace(/^\uFEFF/,'');
  if(text.includes('\uFFFD'))text=buffer.toString('latin1');
  const lines=text.split(/\r?\n/).filter(x=>x.trim()!=='');
  const rows=lines.map(csvSplitLine);
  const headerIndex=rows.findIndex(r=>r.some(c=>norm(c)==='fecha contable')&&r.some(c=>norm(c).includes('cod de concepto')));
  if(headerIndex<0)throw new Error('No encontré las columnas del extracto bancario (Fecha contable / Cod de Concepto).');
  const headers=rows[headerIndex].map(norm), col=(...names)=>{for(const name of names){const idx=headers.findIndex(h=>h===norm(name)||h.includes(norm(name)));if(idx>=0)return idx;}return-1;};
  const idx={date:col('fecha contable'),code:col('cod de concepto'),concept:col('concepto'),debit:col('debito en'),credit:col('credito en'),balance:col('saldo en'),info:col('informacion complementaria'),check:col('nro de cheque','numero de cheque'),branch:col('sucursal origen'),channel:col('canal')};
  const signed=v=>{let t=String(v||'').trim().replace(/\s/g,'').replace(/\$/g,'');if(!t)return 0;if(t.includes('.')&&t.includes(','))t=t.replace(/\./g,'').replace(',','.');else if(t.includes(','))t=t.replace(',','.');const n=Number(t.replace(/[^0-9.\-]/g,''));return Number.isFinite(n)?n:0;};
  const bankAccount=(rows.slice(0,headerIndex).flat().find(x=>/movimientos de/i.test(String(x||'')))||rows[0]?.[0]||'').trim();
  const movements=[];
  for(let r=headerIndex+1;r<rows.length;r++){
    const row=rows[r],code=String(row[idx.code]||'').trim();if(!['9','990'].includes(code))continue;
    const debit=signed(row[idx.debit]),credit=signed(row[idx.credit]),amount=Math.abs(debit||credit||0);if(!(amount>0))continue;
    movements.push({sourceRow:r+1,date:dateYMD(row[idx.date]),code,kind:code==='9'?'checks':'transfers',concept:String(row[idx.concept]||'').trim(),debit,credit,balance:signed(row[idx.balance]),amount,direction:debit<0?'expense':'income',info:String(row[idx.info]||'').trim(),checkNumber:String(row[idx.check]||'').trim(),branch:String(row[idx.branch]||'').trim(),channel:String(row[idx.channel]||'').trim(),bankAccount});
  }
  if(!movements.length)throw new Error('El archivo no contiene movimientos código 9 ni 990.');
  return{bankAccount,movements,totalRows:Math.max(0,rows.length-headerIndex-1)};
}
function normalizeCheck(v){return checkLast5(v,{pad:true});}
function ymdDays(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(v||'')))return null;const[y,m,d]=v.split('-').map(Number);return Date.UTC(y,m-1,d)/86400000;}
function txDateDistance(bankDate,tx){const b=ymdDays(bankDate);if(b==null)return 9999;const vals=[tx.date,tx.dueDate,tx.paidAt].map(ymdDays).filter(x=>x!=null);return vals.length?Math.min(...vals.map(x=>Math.abs(x-b))):9999;}
function bankCandidateRows(bank,txs,kind){
  const paymentOk=t=>kind==='checks'?isCheckPayment(t.paymentMethod):t.paymentMethod==='transfer';
  const amountOk=t=>Math.abs(Number(t.amount||0)-Number(bank.amount||0))<0.011;
  const eligible=txs.filter(t=>t.status!=='cancelled'&&paymentOk(t)&&t.type===bank.direction&&amountOk(t));
  const scored=eligible.map(t=>{
    const dd=txDateDistance(bank.date,t);let score=0;
    if(kind==='checks'){
      const b=normalizeCheck(bank.checkNumber),x=normalizeCheck(t.checkNumber);if(b&&x&&b===x)score+=120;else if(b&&x)score-=40;
      if(dd===0)score+=12;else if(dd<=7)score+=Math.max(1,8-dd);
    }else{
      if(dd===0)score+=30;else if(dd<=1)score+=20;else if(dd<=3)score+=12;else if(dd<=7)score+=4;
    }
    if(t.status==='paid')score+=2;
    return{tx:t,score,days:dd};
  }).sort((a,b)=>b.score-a.score||a.days-b.days);
  return scored;
}
function txMini(t){return{_id:t._id,date:t.date,dueDate:t.dueDate,counterparty:t.counterparty,category:t.category,amount:Number(t.amount||0),paymentMethod:t.paymentMethod,checkNumber:t.checkNumber||'',status:t.status,controlled:!!t.controlled};}

app.post('/api/bank-reconciliation/import',auth,async(req,res)=>{
  try{
    const b64=String(req.body.dataBase64||'');if(!b64)throw new Error('No recibí el archivo del banco');
    const buffer=Buffer.from(b64,'base64');if(!buffer.length)throw new Error('El archivo está vacío');
    const fileHash=crypto.createHash('sha256').update(buffer).digest('hex'),existing=(await store.list('bankImports',{fileHash}))[0];
    if(existing){const rows=await store.list('bankMovements',{batchId:existing._id});return res.json({ok:true,duplicate:true,batch:existing,counts:{checks:rows.filter(x=>x.code==='9').length,transfers:rows.filter(x=>x.code==='990').length,total:rows.length}});}
    const parsed=parseBankCsvBuffer(buffer),filename=String(req.body.filename||'extracto.csv').trim(),accountId=String(req.body.accountId||'').trim();
    if(accountId){const a=await store.find('accounts',accountId);if(!a||a.active===false)throw new Error('La cuenta seleccionada no existe');}
    const dates=parsed.movements.map(x=>x.date).filter(Boolean).sort(),batch=await store.create('bankImports',{fileName:filename,fileHash,bankAccount:parsed.bankAccount,accountId:accountId||null,fromDate:dates[0]||'',toDate:dates[dates.length-1]||'',totalRows:parsed.totalRows,relevantRows:parsed.movements.length,checks:parsed.movements.filter(x=>x.code==='9').length,transfers:parsed.movements.filter(x=>x.code==='990').length,uploadedBy:req.user?.username||ADMIN_USER});
    await store.createMany('bankMovements',parsed.movements.map(x=>({...x,batchId:batch._id,fileName:filename,linkedTransactionId:null,controlled:false,controlledAt:'',controlledBy:''})));
    res.json({ok:true,duplicate:false,batch,counts:{checks:batch.checks,transfers:batch.transfers,total:batch.relevantRows}});
  }catch(e){res.status(400).json({error:'No pude importar el extracto: '+e.message});}
});
app.get('/api/bank-reconciliation/imports',auth,async(req,res)=>{
  const rows=await store.list('bankImports');rows.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));res.json(rows.slice(0,36));
});
app.delete('/api/bank-reconciliation/imports/:id',auth,async(req,res)=>{
  const batch=await store.find('bankImports',req.params.id);if(!batch)return res.status(404).json({error:'Extracto no encontrado'});
  await store.removeMany('bankMovements',{batchId:req.params.id});await store.remove('bankImports',req.params.id);res.json({ok:true});
});
app.get('/api/bank-reconciliation',auth,async(req,res)=>{
  const batches=await store.list('bankImports');batches.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));const batchId=String(req.query.batchId||batches[0]?._id||'');
  if(!batchId)return res.json({batch:null,summary:{total:0,controlled:0,linked:0,suggested:0,ambiguous:0,missing:0,appOnly:0},rows:[],appOnly:[]});
  const batch=batches.find(x=>x._id===batchId)||await store.find('bankImports',batchId);if(!batch)return res.status(404).json({error:'Extracto no encontrado'});
  const kind=req.query.kind==='transfers'?'transfers':'checks',code=kind==='checks'?'9':'990';
  let [bankRows,txs]=await Promise.all([store.list('bankMovements',{batchId}),store.list('transactions')]);if(batch.accountId)txs=txs.filter(t=>t.account===batch.accountId);bankRows=bankRows.filter(x=>x.code===code).sort((a,b)=>(b.date||'').localeCompare(a.date||'')||Number(a.sourceRow)-Number(b.sourceRow));
  const txMap=new Map(txs.map(t=>[t._id,t])),associated=new Set();
  const rows=bankRows.map(b=>{
    const linked=b.linkedTransactionId?txMap.get(b.linkedTransactionId):null;if(linked)associated.add(linked._id);
    const scored=linked?[]:bankCandidateRows(b,txs,kind),top=scored[0],sameTop=top?scored.filter(x=>x.score===top.score).length:0;
    let matchStatus='missing',suggested=null;
    if(linked)matchStatus=b.controlled?'controlled':'linked';
    else if(top&&sameTop===1&&((kind==='checks'&&top.score>=120)||(kind==='transfers'&&top.score>=12))){suggested=top.tx;matchStatus='suggested';associated.add(top.tx._id);}
    else if(top)matchStatus='ambiguous';
    const candidates=scored.slice(0,6).map(x=>({...txMini(x.tx),matchScore:x.score,days:x.days}));
    return{...b,linkedTransaction:linked?txMini(linked):null,suggestedTransaction:suggested?txMini(suggested):null,candidates,matchStatus};
  });
  const dates=bankRows.map(x=>x.date).filter(Boolean).sort(),from=dates[0]||batch.fromDate||'',to=dates[dates.length-1]||batch.toDate||'';
  const eligibleApp=txs.filter(t=>t.status!=='cancelled'&&(kind==='checks'?isCheckPayment(t.paymentMethod):t.paymentMethod==='transfer')&&(!from||[t.date,t.dueDate,t.paidAt].filter(Boolean).some(d=>d>=from&&d<=to)));
  const appOnly=eligibleApp.filter(t=>!associated.has(t._id)).sort((a,b)=>(b.dueDate||b.date||'').localeCompare(a.dueDate||a.date||'')).map(txMini);
  const filter=String(req.query.status||'');let filtered=rows;if(filter)filtered=rows.filter(r=>r.matchStatus===filter||(filter==='uncontrolled'&&!r.controlled));
  const summary={total:rows.length,controlled:rows.filter(x=>x.controlled).length,linked:rows.filter(x=>x.matchStatus==='linked').length,suggested:rows.filter(x=>x.matchStatus==='suggested').length,ambiguous:rows.filter(x=>x.matchStatus==='ambiguous').length,missing:rows.filter(x=>x.matchStatus==='missing').length,appOnly:appOnly.length};
  res.json({batch,kind,summary,rows:filtered,appOnly});
});
app.patch('/api/bank-reconciliation/:id',auth,async(req,res)=>{
  try{
    const bank=await store.find('bankMovements',req.params.id);if(!bank)return res.status(404).json({error:'Movimiento bancario no encontrado'});
    const linkedTransactionId=req.body.linkedTransactionId===undefined?bank.linkedTransactionId:(req.body.linkedTransactionId||null),controlled=req.body.controlled===undefined?!!bank.controlled:!!req.body.controlled;
    let tx=null;if(linkedTransactionId){tx=await store.find('transactions',linkedTransactionId);if(!tx)throw new Error('El movimiento de la app seleccionado ya no existe');const correct=bank.code==='9'?isCheckPayment(tx.paymentMethod):tx.paymentMethod==='transfer';if(!correct)throw new Error('El movimiento seleccionado no corresponde al tipo bancario');if(Math.abs(Number(tx.amount||0)-Number(bank.amount||0))>=0.011)throw new Error('El monto del movimiento de la app no coincide con el del banco');if(bank.code==='9'){const b=normalizeCheck(bank.checkNumber),x=normalizeCheck(tx.checkNumber);if(b&&x&&b!==x)throw new Error('Los últimos 5 dígitos del cheque no coinciden con el banco');}}
    if(controlled&&!linkedTransactionId)throw new Error('Para marcar como controlado primero debe estar vinculado a un movimiento de la app');
    const stamp=controlled?new Date().toISOString():'';const item=await store.update('bankMovements',bank._id,{linkedTransactionId,controlled,controlledAt:stamp,controlledBy:controlled?(req.user?.username||ADMIN_USER):''});
    if(linkedTransactionId)await store.update('transactions',linkedTransactionId,{controlled,controlledAt:stamp,controlledBy:controlled?(req.user?.username||ADMIN_USER):''});
    if(bank.linkedTransactionId&&bank.linkedTransactionId!==linkedTransactionId){const other=(await store.list('bankMovements',{linkedTransactionId:bank.linkedTransactionId})).some(x=>x._id!==bank._id&&x.controlled);if(!other)await store.update('transactions',bank.linkedTransactionId,{controlled:false,controlledAt:'',controlledBy:''});}
    res.json({ok:true,item});
  }catch(e){res.status(400).json({error:e.message});}
});

async function calcCurrentBalance(){return (await accountBalances()).reduce((s,a)=>s+Number(a.currentBalance||0),0);}
app.get('/api/dashboard',auth,async(req,res)=>{
  const today=todayAR(),horizon=req.query.to||addMonths(today,12),allTxs=await store.list('transactions'),txs=allTxs.filter(x=>!x.isInternalTransfer),currentBalance=await calcCurrentBalance();
  const pending=txs.filter(t=>t.status==='pending'),sum=(arr,type)=>arr.filter(x=>x.type===type).reduce((s,x)=>s+Number(x.amount||0),0),pendingIncome=sum(pending,'income'),pendingExpense=sum(pending,'expense');
  const overdue=pending.filter(x=>x.dueDate<today),next30=addMonths(today,1),n30=pending.filter(x=>x.dueDate>=today&&x.dueDate<=next30),future=pending.filter(x=>x.dueDate>=today&&x.dueDate<=horizon).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));let saldo=currentBalance;
  const projection=future.map(t=>{saldo+=t.type==='income'?Number(t.amount):-Number(t.amount);return{date:t.dueDate,balance:saldo,amount:t.amount,type:t.type,counterparty:t.counterparty,category:t.category};});
  const catMap=new Map();for(const t of txs.filter(x=>x.type==='expense'&&x.status==='paid'))catMap.set(t.category,(catMap.get(t.category)||0)+Number(t.amount));
  const categories=[...catMap].map(([_id,total])=>({_id,total})).sort((a,b)=>b.total-a.total).slice(0,10),upcoming=pending.filter(x=>x.dueDate>=today).sort((a,b)=>a.dueDate.localeCompare(b.dueDate)).slice(0,12),monthMap=new Map();
  for(const t of txs.filter(x=>['paid','pending'].includes(x.status))){const key=`${t.dueDate.slice(0,7)}|${t.type}`;monthMap.set(key,(monthMap.get(key)||0)+Number(t.amount));}
  const monthly=[...monthMap].map(([key,total])=>{const[month,type]=key.split('|');return{_id:{month,type},total};}).sort((a,b)=>a._id.month.localeCompare(b._id.month));
  res.json({today,currentBalance,pendingIncome,pendingExpense,projectedBalance:currentBalance+pendingIncome-pendingExpense,next30Income:sum(n30,'income'),next30Expense:sum(n30,'expense'),overdueIncome:sum(overdue,'income'),overdueExpense:sum(overdue,'expense'),projection,monthly,categories,upcoming});
});

async function reportTxs(req){let [txs,accounts]=await Promise.all([store.list('transactions'),store.list('accounts')]);txs=txs.filter(x=>!x.isInternalTransfer);if(req.query.from)txs=txs.filter(x=>x.dueDate>=req.query.from);if(req.query.to)txs=txs.filter(x=>x.dueDate<=req.query.to);return txs.sort((a,b)=>a.dueDate.localeCompare(b.dueDate)).map(t=>populateAccount(t,accounts));}
app.get('/api/reports/excel',auth,async(req,res)=>{
  const txs=await reportTxs(req),[allTxs,accounts]=await Promise.all([store.list('transactions'),store.list('accounts')]),wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Movimientos');
  ws.columns=[{header:'Controlado',key:'controlled',width:12},{header:'Fecha control',key:'controlledAt',width:20},{header:'Tipo',key:'type',width:12},{header:'Estado',key:'status',width:14},{header:'Fecha',key:'date',width:13},{header:'Vencimiento',key:'dueDate',width:13},{header:'Cliente / Proveedor',key:'counterparty',width:28},{header:'Empleado',key:'employee',width:24},{header:'Categoría',key:'category',width:22},{header:'Monto',key:'amount',width:16},{header:'Medio de pago',key:'paymentMethod',width:20},{header:'Últimos 5 cheque / E-cheq',key:'checkNumber',width:22},{header:'Cuenta',key:'account',width:22},{header:'Origen',key:'source',width:12},{header:'Notas',key:'notes',width:35}];
  ws.getRow(1).font={bold:true};ws.views=[{state:'frozen',ySplit:1}];
  txs.forEach(t=>ws.addRow({controlled:t.controlled?'Sí':'No',controlledAt:t.controlledAt||'',type:t.type==='income'?'Ingreso':'Egreso',status:t.status==='paid'?'Pagado/Cobrado':t.status==='pending'?'Pendiente':'Cancelado',date:t.date,dueDate:t.dueDate,counterparty:isSalaryCategory(t.category)?'':t.counterparty,employee:isSalaryCategory(t.category)?t.counterparty:'',category:t.category,amount:t.amount,paymentMethod:({cash:'Efectivo',transfer:'Transferencia',check:'Cheque',echeck:'Cheque electrónico',unspecified:'Sin definir'})[t.paymentMethod||'unspecified'],checkNumber:isCheckPayment(t.paymentMethod)?checkLast5(t.checkNumber,{pad:true}):'',account:t.account?.name||'',source:t.source,notes:t.notes}));
  ws.getColumn('amount').numFmt='$#,##0.00';
  const own=transferGroupView(allTxs,accounts).filter(t=>(!req.query.from||t.date>=req.query.from)&&(!req.query.to||t.date<=req.query.to)),ow=wb.addWorksheet('Cuentas propias');
  ow.columns=[{header:'Fecha',key:'date',width:13},{header:'Cuenta origen',key:'from',width:25},{header:'Cuenta destino',key:'to',width:25},{header:'Monto',key:'amount',width:16},{header:'Estado',key:'status',width:14},{header:'Control origen',key:'fromControlled',width:15},{header:'Control destino',key:'toControlled',width:15},{header:'Notas',key:'notes',width:35}];ow.getRow(1).font={bold:true};ow.views=[{state:'frozen',ySplit:1}];
  own.forEach(t=>ow.addRow({date:t.date,from:t.fromAccount?.name||'',to:t.toAccount?.name||'',amount:t.amount,status:t.status==='paid'?'Realizada':t.status==='pending'?'Pendiente':'Cancelada',fromControlled:t.fromControlled?'Sí':'No',toControlled:t.toControlled?'Sí':'No',notes:t.notes||''}));ow.getColumn('amount').numFmt='$#,##0.00';
  const buffer=await wb.xlsx.writeBuffer();res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="Las_Tres_Marias_Finanzas.xlsx"');res.send(Buffer.from(buffer));
});
app.get('/api/reports/pdf',auth,async(req,res)=>{
  const txs=await reportTxs(req),current=await calcCurrentBalance(),income=txs.filter(x=>x.type==='income').reduce((a,b)=>a+Number(b.amount),0),expense=txs.filter(x=>x.type==='expense').reduce((a,b)=>a+Number(b.amount),0);
  const doc=new PDFDocument({margin:40,size:'A4'}),chunks=[];doc.on('data',d=>chunks.push(d));doc.on('end',()=>{res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="Las_Tres_Marias_Finanzas.pdf"');res.send(Buffer.concat(chunks));});
  doc.fontSize(20).text('Las Tres Marías - Finanzas',{align:'center'});doc.moveDown(.5);doc.fontSize(10).text(`Reporte generado: ${todayAR()}`,{align:'center'});doc.moveDown();doc.fontSize(12).text(`Saldo real actual: $ ${current.toLocaleString('es-AR')}`);doc.text(`Ingresos del reporte: $ ${income.toLocaleString('es-AR')}`);doc.text(`Egresos del reporte: $ ${expense.toLocaleString('es-AR')}`);doc.moveDown();doc.fontSize(11).text('Movimientos',{underline:true});doc.moveDown(.4);
  txs.slice(0,250).forEach(t=>{if(doc.y>760)doc.addPage();const cheque=isCheckPayment(t.paymentMethod)?` | Últ. 5 ${checkLast5(t.checkNumber,{pad:true})||'SIN NÚMERO'}`:'';const ctl=t.controlled?' | CONTROLADO':'';doc.fontSize(9).text(`${t.dueDate} | ${t.type==='income'?'INGRESO':'EGRESO'} | ${t.counterparty} | ${t.category} | $ ${Number(t.amount).toLocaleString('es-AR')} | ${({cash:'EFECTIVO',transfer:'TRANSFERENCIA',check:'CHEQUE',echeck:'E-CHEQ',unspecified:'SIN DEFINIR'})[t.paymentMethod||'unspecified']}${cheque} | ${t.status}${ctl}`);});
  if(txs.length>250)doc.moveDown().text(`Se muestran 250 de ${txs.length} movimientos. Use Excel para el detalle completo.`);
  const [allRows,accs]=await Promise.all([store.list('transactions'),store.list('accounts')]);const own=transferGroupView(allRows,accs).filter(t=>(!req.query.from||t.date>=req.query.from)&&(!req.query.to||t.date<=req.query.to));
  if(own.length){doc.addPage();doc.fontSize(14).text('Movimientos entre cuentas propias',{underline:true});doc.moveDown(.5);own.slice(0,200).forEach(t=>{if(doc.y>760)doc.addPage();doc.fontSize(9).text(`${t.date} | ${t.fromAccount?.name||''} -> ${t.toAccount?.name||''} | $ ${Number(t.amount).toLocaleString('es-AR')} | ${t.status}`);});}
  doc.end();
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
if(require.main===module){store.init().then(()=>app.listen(port,host,()=>console.log(`\nLas Tres Marías Finanzas v10\nhttp://localhost:${port}\nMongoDB: ${store.DB_NAME}\n`))).catch(e=>{console.error(e);process.exit(1);});}
module.exports=app;
