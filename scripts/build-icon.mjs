import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),run=promisify(execFile);
const directory=path.join(root,'.cache/branding/REVA.iconset');
await fs.mkdir(directory,{recursive:true});
for(const size of [16,32,128,256,512]) {
  for(const scale of [1,2]) {
    await run('/usr/bin/sips',['-z',String(size*scale),String(size*scale),path.join(root,'branding/logo.png'),'--out',path.join(directory,`icon_${size}x${size}${scale===2?'@2x':''}.png`)]);
  }
}
await run('/usr/bin/iconutil',['-c','icns',directory,'-o',path.join(root,'.cache/branding/REVA.icns')]);
console.log('Generated REVA.icns from the original REVA logo.');
