require('dotenv').config();
const fs=require('fs');
const path=require('path');
const store=require('../lib/store');

(async()=>{
  const input=process.argv[2]||path.join(__dirname,'..','data','finanzas.json');
  if(!fs.existsSync(input))throw new Error(`No encontré el archivo: ${input}`);
  const snapshot=JSON.parse(fs.readFileSync(input,'utf8'));
  await store.upsertSnapshot(snapshot,{replace:true});
  console.log(`Migración terminada desde ${input} a MongoDB (${store.DB_NAME}).`);
  process.exit(0);
})().catch(e=>{console.error('Error de migración:',e.message);process.exit(1);});
