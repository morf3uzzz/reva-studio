// Original REVA artwork and synthesized sounds. No vendor artwork is read.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function write(relative, bytes) {
  const destination = path.join(publicRoot, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
  return { bytes: Buffer.byteLength(bytes), sha256: digest(bytes) };
}
const themes = [
  ['REVA', 'Violet Flow', '#0d1021', '#783fff', '#53e4c0'],
  ['REVA', 'Blue Hour', '#071226', '#3463eb', '#a0beff'],
  ['REVA', 'Mint Circuit', '#071b23', '#168976', '#8bf0c5'],
  ['REVA', 'Rose Quartz', '#27102b', '#b448ba', '#ffc7d9'],
  ['REVA', 'Amber Glass', '#231407', '#dc8a36', '#ffd7a0'],
  ['REVA', 'Deep Indigo', '#0d0d20', '#4942c4', '#ac91f7'],
  ['Aurora', 'Polar Light', '#071c25', '#36a2a6', '#b2ffd0'],
  ['Aurora', 'Electric Iris', '#0c102c', '#7164ff', '#e39cef'],
  ['Aurora', 'Ocean Current', '#081c36', '#219cd0', '#8bdfef'],
  ['Aurora', 'Northern Sky', '#17172d', '#a076d9', '#71e8c6'],
  ['Dusk', 'Peach Horizon', '#31243a', '#d57390', '#ffcd9b'],
  ['Dusk', 'Copper Evening', '#27141c', '#b06666', '#efb56e'],
  ['Dusk', 'Lilac Sunset', '#211f42', '#9d79bf', '#f9bea9'],
  ['Dusk', 'Afterglow', '#1f1431', '#9b467e', '#f0a78d'],
  ['Mono', 'Graphite', '#0b0e13', '#343a49', '#838d9f'],
  ['Mono', 'Porcelain', '#cbcdd5', '#e4e5ec', '#ffffff'],
  ['Mono', 'Silver Mist', '#697582', '#b1bdc9', '#e3eaf2'],
  ['Mono', 'Obsidian', '#07090d', '#1b202c', '#4c5470'],
];
const wallpapers = [];
for (const [i, [category, name, dark, mid, light]] of themes.entries()) {
  const file = `${category.toLowerCase()}/${name.toLowerCase().replaceAll(' ', '-')}.svg`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600" viewBox="0 0 2400 1600"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="${dark}"/><stop offset="1" stop-color="${mid}"/></linearGradient><radialGradient id="g"><stop stop-color="${light}" stop-opacity=".65"/><stop offset="1" stop-color="${mid}" stop-opacity="0"/></radialGradient><linearGradient id="r" x2=".8" y2="1"><stop stop-color="${light}" stop-opacity=".6"/><stop offset=".45" stop-color="${mid}" stop-opacity=".3"/><stop offset="1" stop-color="${dark}" stop-opacity=".05"/></linearGradient></defs><path fill="url(#b)" d="M0 0h2400v1600H0z"/><ellipse fill="url(#g)" cx="${500+i*53}" cy="400" rx="1500" ry="1100"/><path fill="url(#r)" d="M-300 1450C300 900 650 1300 1050 650S1900-200 2700 150v400C1900 50 1450 600 1200 1050S300 1700-300 1850Z"/><path fill="none" stroke="${light}" stroke-opacity=".13" stroke-width="2" d="M-200 1470C350 820 740 1390 1110 650S1940-190 2600 200"/></svg>`;
  const properties = await write(`wallpapers/${file}`, svg);
  wallpapers.push({ name, category, file, width: 2400, height: 1600, format: 'svg', ...properties });
}
await fs.writeFile(path.join(root, 'wallpapers.json'), JSON.stringify({ schemaVersion: 1, license: 'MIT', author: 'REVA Studio contributors', default: wallpapers[0].file, entries: wallpapers }, null, 2)+'\n');
// Legacy set IDs preserve existing document compatibility; every path is new art.
const sets = ['macos', 'macos-tahoe', 'touch', ...Array.from({length:20}, (_,i)=>`custom-${i+1}`), 'halloween'];
const colors = ['#ffffff','#c9bcff','#63e2c2','#ffcd70','#72b9ff','#f6a6ce'];
const entries = [];
for (const [index, set] of sets.entries()) {
  const variants = set.startsWith('custom-') ? 4 : 1;
  for (let variant=1;variant<=variants;variant++) {
    const fill = colors[(index+variant-1)%colors.length];
    const body = set==='touch' ? `<circle cx="32" cy="32" r="23" fill="${fill}" fill-opacity=".8" stroke="#151720" stroke-width="3"/>` : `<path d="M2.56 2.56V53L16 39l10 22 10-5-10-22 20-1Z" fill="${fill}" stroke="#11141c" stroke-width="2.8" stroke-linejoin="round"/>`;
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${body}</svg>`;
    const file=`${set}/pointer-${variant}.svg`;
    const properties=await write(`cursors/${file}`,svg);
    entries.push({set,type:'pointer',id:`pointer-${variant}`,file,width:64,height:64,hotspot:set==='touch'?{x:.5,y:.5}:{x:.04,y:.04},sha256:properties.sha256});
  }
  if (!set.startsWith('custom-') && set!=='touch') {
    const shapes={ibeam:'M22 5h20M32 5v54M22 59h20',cross:'M32 6v52M6 32h52',pointingHand:'M24 55V17a5 5 0 0110 0v17-9a5 5 0 0110 0v11-6a5 5 0 0110 0v15c0 9-7 15-16 15H24L12 41a5 5 0 017-6l5 5'};
    for(const [type,d] of Object.entries(shapes)) {
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path d="${d}" fill="${type==='pointingHand'?'#fff':'none'}" stroke="#171a22" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/><path d="${d}" fill="${type==='pointingHand'?'#fff':'none'}" stroke="#fff" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
      const file=`${set}/${type}.svg`,properties=await write(`cursors/${file}`,svg);
      entries.push({set,type,id:`${type}-1`,file,width:64,height:64,hotspot:{x:.5,y:type==='pointingHand'?.2:.5},sha256:properties.sha256});
    }
  }
}
await fs.writeFile(path.join(root,'cursors.json'),JSON.stringify({schemaVersion:1,license:'MIT',author:'REVA Studio contributors',sets,entries},null,2)+'\n');
for(const [index,sound] of ['apple-magic-mouse','logitech-mx-master'].entries()) {
  for(const [type,duration] of [['click',.055],['down',.035],['up',.025]]) {
    const rate=44100,count=Math.ceil(rate*duration),buffer=Buffer.alloc(44+count*2);
    buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(count*2,40);
    let seed=0x52455641;
    for(let i=0;i<count;i++) { const t=i/rate;seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=seed/0xffffffff*2-1;const envelope=Math.exp(-t*(index?150:210))*Math.min(1,i/12);const value=(.5*Math.sin(2*Math.PI*(index?1500:900)*t)+.2*noise)*envelope;buffer.writeInt16LE(Math.round(value*18000),44+i*2); }
    await write(`sounds/clicks/${sound}/${type}.wav`,buffer);
  }
}
await write('icons/scissors.svg','<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g fill="none" stroke="#080a10" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="9" r="4"/><circle cx="8" cy="23" r="4"/><path d="m11 12 17 15M11 20 28 5"/></g><g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="9" r="4"/><circle cx="8" cy="23" r="4"/><path d="m11 12 17 15M11 20 28 5"/></g></svg>');
console.log(`Generated ${wallpapers.length} original wallpapers, ${entries.length} cursor variants and six synthesized sounds.`);
