import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {modelResourceHashes,verifyModelResources} from './model-resources.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../resources/models');
const revision='8a57d04190768bcf924ae88b59f82558f90b9a1d';
for(const [relative,expected] of Object.entries(modelResourceHashes)) {
  const destination=path.join(root,relative);
  try {
    const bytes=await fs.readFile(destination);
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected) throw new Error(`Existing model checksum mismatch: ${relative}`);
    continue;
  } catch(error) {if(error.code!=='ENOENT')throw error;}
  if(!relative.startsWith('PiperSR_2x.mlpackage/')) throw new Error(`Missing checked-in attribution resource: ${relative}`);
  const url=`https://raw.githubusercontent.com/ModelPiper/PiperSR/${revision}/${relative}`;
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw new Error(`Model download failed: ${response.status} ${relative}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>2*1024*1024 || crypto.createHash('sha256').update(bytes).digest('hex')!==expected) throw new Error(`Model download checksum mismatch: ${relative}`);
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.writeFile(destination,bytes,{flag:'wx'});
}
await verifyModelResources(root);
console.log('Pinned PiperSR model and attribution verified.');
