const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const DEFAULT_CATEGORIES = [
  ['Venta de leche','income'],['Venta de hacienda','income'],['Venta de cereal','income'],['Servicios','income'],['Otros ingresos','income'],
  ['Alimentación','expense'],['Combustible','expense'],['Veterinaria','expense'],['Medicamentos','expense'],['Personal','expense'],['Sueldos','expense'],
  ['Repuestos','expense'],['Maquinaria','expense'],['Contratistas','expense'],['Energía','expense'],['Semillas','expense'],
  ['Fertilizantes','expense'],['Agroquímicos','expense'],['Alquileres','expense'],['Seguros','expense'],['Mantenimiento','expense'],['Inversión / Infraestructura','expense'],['Otros egresos','expense']
];

const id = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const DB_NAME = process.env.MONGODB_DB || 'las_tres_marias_finanzas';

let initPromise = null;

function uri(){
  const value = String(process.env.MONGODB_URI || '').trim();
  if(!value) throw new Error('Falta la variable MONGODB_URI. Configurala en Vercel con tu conexión de MongoDB Atlas.');
  return value;
}

async function getClient(){
  if(!globalThis.__ltmMongoClientPromise){
    const client = new MongoClient(uri(), { maxPoolSize: 10, minPoolSize: 0, serverSelectionTimeoutMS: 10000 });
    globalThis.__ltmMongoClientPromise = client.connect().catch(err=>{
      globalThis.__ltmMongoClientPromise = null;
      throw err;
    });
  }
  return globalThis.__ltmMongoClientPromise;
}

async function db(){
  const client = await getClient();
  return client.db(DB_NAME);
}

async function initInner(){
  const database = await db();
  const ts = nowIso();

  await Promise.all([
    database.collection('transactions').createIndex({ dueDate: 1 }),
    database.collection('transactions').createIndex({ createdAt: -1 }),
    database.collection('transactions').createIndex({ controlled: 1 }),
    database.collection('providers').createIndex({ name: 1 }),
    database.collection('employees').createIndex({ name: 1 }),
    database.collection('categories').createIndex({ name: 1 }),
    database.collection('accounts').createIndex({ name: 1 }),
    database.collection('bankImports').createIndex({ createdAt: -1 }),
    database.collection('bankImports').createIndex({ fileHash: 1 }, { unique: true }),
    database.collection('bankMovements').createIndex({ batchId: 1, date: -1 }),
    database.collection('bankMovements').createIndex({ code: 1, controlled: 1 }),
    database.collection('bankMovements').createIndex({ linkedTransactionId: 1 }),
    database.collection('transactions').createIndex({ internalTransferId: 1 })
  ]);

  for(const [name,type] of DEFAULT_CATEGORIES){
    await database.collection('categories').updateOne(
      { name },
      { $setOnInsert: { _id:id(), name, type, active:true, createdAt:ts, updatedAt:ts } },
      { upsert:true }
    );
  }

  if(await database.collection('accounts').countDocuments({}) === 0){
    await database.collection('accounts').insertOne({
      _id:id(), name:'Caja principal', type:'cash', openingBalance:0, active:true, createdAt:ts, updatedAt:ts
    });
  }

  await database.collection('meta').updateOne(
    { _id:'app' },
    { $setOnInsert:{ createdAt:ts, company:'Las Tres Marías' }, $set:{ updatedAt:ts, version:9, storage:'mongodb' } },
    { upsert:true }
  );
  return database;
}

async function init(){
  if(!initPromise){
    initPromise = initInner().catch(err=>{ initPromise=null; throw err; });
  }
  return initPromise;
}

async function collection(name){
  await init();
  const database = await db();
  return database.collection(name);
}

function cleanDoc(doc){
  if(!doc) return null;
  if(doc._id && typeof doc._id !== 'string') doc._id=String(doc._id);
  return doc;
}

async function list(name, filter={}){
  const c=await collection(name);
  return (await c.find(filter).toArray()).map(cleanDoc);
}

async function find(name,itemId){
  const c=await collection(name);
  return cleanDoc(await c.findOne({_id:itemId}));
}

async function create(name,payload){
  const c=await collection(name); const ts=nowIso();
  const item={_id:id(),...payload,createdAt:ts,updatedAt:ts};
  await c.insertOne(item);
  await touchMeta();
  return item;
}

async function createMany(name,payloads){
  if(!Array.isArray(payloads)||!payloads.length)return [];
  const c=await collection(name); const ts=nowIso();
  const items=payloads.map(p=>({_id:id(),...p,createdAt:ts,updatedAt:ts}));
  await c.insertMany(items,{ordered:true});
  await touchMeta();
  return items;
}

async function update(name,itemId,patch){
  const c=await collection(name); const updatedAt=nowIso();
  await c.updateOne({_id:itemId},{$set:{...patch,updatedAt},$unset:{__removeMe:''}});
  await touchMeta();
  return cleanDoc(await c.findOne({_id:itemId}));
}

async function remove(name,itemId){
  const c=await collection(name); const r=await c.deleteOne({_id:itemId});
  if(r.deletedCount) await touchMeta();
  return !!r.deletedCount;
}

async function removeMany(name,filter={}){
  const c=await collection(name); const r=await c.deleteMany(filter);
  if(r.deletedCount) await touchMeta();
  return r.deletedCount||0;
}

async function touchMeta(){
  const database=await db();
  await database.collection('meta').updateOne({_id:'app'},{$set:{updatedAt:nowIso(),version:9,storage:'mongodb'}},{upsert:true});
}

async function status(){
  const database=await db();
  await database.command({ping:1});
  const meta=await database.collection('meta').findOne({_id:'app'});
  return {mode:'mongodb',connected:true,database:DB_NAME,updatedAt:meta?.updatedAt||''};
}

async function exportAll(){
  await init();
  const [categories,providers,employees,accounts,transactions,bankImports,bankMovements,meta] = await Promise.all([
    list('categories'), list('providers'), list('employees'), list('accounts'), list('transactions'), list('bankImports'), list('bankMovements'), list('meta')
  ]);
  return {version:9,exportedAt:nowIso(),company:'Las Tres Marías',meta,categories,providers,employees,accounts,transactions,bankImports,bankMovements};
}

async function upsertSnapshot(snapshot,{replace=false}={}){
  await init();
  const allowed=['categories','providers','employees','accounts','transactions','bankImports','bankMovements'];
  const database=await db();
  if(replace){
    for(const name of allowed) await database.collection(name).deleteMany({});
  }
  for(const name of allowed){
    const rows=Array.isArray(snapshot?.[name])?snapshot[name]:[];
    if(!rows.length)continue;
    const c=database.collection(name);
    const ops=rows.filter(x=>x&&x._id).map(x=>{
      const {_id,...rest}=x;
      return {updateOne:{filter:{_id:String(_id)},update:{$set:{...rest,updatedAt:x.updatedAt||nowIso()}},upsert:true}};
    });
    if(ops.length)await c.bulkWrite(ops,{ordered:false});
  }
  const ts=nowIso();
  for(const [name,type] of DEFAULT_CATEGORIES){
    await database.collection('categories').updateOne(
      {name},
      {$setOnInsert:{_id:id(),name,type,active:true,createdAt:ts,updatedAt:ts}},
      {upsert:true}
    );
  }
  if(await database.collection('accounts').countDocuments({})===0){
    await database.collection('accounts').insertOne({_id:id(),name:'Caja principal',type:'cash',openingBalance:0,active:true,createdAt:ts,updatedAt:ts});
  }
  await touchMeta();
}

module.exports={init,list,find,create,createMany,update,remove,removeMany,status,exportAll,upsertSnapshot,DB_NAME};
