import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {downloadArtifact} from '@electron/get';
import {makeUniversalApp} from '@electron/universal';
import {signApp,resolveSigningIdentity} from './package-mac-support.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),exec=promisify(execFile);
if(process.platform!=='darwin') throw new Error('macOS release packaging requires macOS and Apple Command Line Tools.');
const info=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const argument=process.argv.find(arg=>arg.startsWith('--arch='));
const selected=argument?.slice(7) ?? 'universal';
if(!['arm64','x64','universal'].includes(selected)) throw new Error('Use --arch=arm64, x64 or universal.');
const run=(command,args=[],extra={})=>new Promise((resolve,reject)=>{
 const child=spawn(command,args,{cwd:root,stdio:'inherit',...extra});
 child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`${path.basename(command)} exited ${code}`)));
});
const output=path.join(root,'build/releases');await fs.mkdir(output,{recursive:true});
// Fail before generating assets or compiling either architecture when a release
// destination already belongs to an earlier candidate. Keep the late check too.
const prefix=`REVA-Studio-${info.version}-macOS-${selected}`;
const archive=path.join(output,`${prefix}.zip`),diskImage=path.join(output,`${prefix}.dmg`);
const finalApp=path.join(root,'build',`macOS-${selected}`,'REVA Studio.app');
const destinations=[archive,diskImage,path.join(output,`${prefix}.sha256`),path.join(output,`${prefix}.build.json`),finalApp];
for(const file of destinations) {try{await fs.access(file);throw new Error(`Release destination exists: ${file}`);}catch(error){if(error.code!=='ENOENT')throw error;}}
const job=await fs.mkdtemp(path.join(root,'build/.release-'));
const arches=selected==='universal'?['arm64','x64']:[selected];
let complete=false;
try {
 await run(process.execPath,['scripts/generate-assets.mjs']);
 await run(process.execPath,['scripts/fetch-model.mjs']);
 await run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit']);
 await run(process.execPath,['node_modules/vite/bin/vite.js','build']);
 await run(process.execPath,['scripts/build-icon.mjs']);
 const apps={};
 for(const arch of arches) {
  const zip=await downloadArtifact({version:info.devDependencies.electron,artifactName:'electron',platform:'darwin',arch,cacheRoot:path.join(root,'.cache/electron-downloads')});
  const distribution=path.join(job,`electron-${arch}`);await fs.mkdir(distribution);
  await run('/usr/bin/ditto',['-x','-k',zip,distribution]);
  const native=path.join(job,`reva-capture-${arch}`);
  const env={...process.env,REVA_NATIVE_ARCH:arch==='x64'?'x86_64':'arm64',REVA_NATIVE_OUTPUT:native};
  await run('/bin/bash',['scripts/build-native.sh'],{env});
  const directory=path.join(job,arch);
  await run(process.execPath,['scripts/package-mac.mjs'],{env:{...env,REVA_ELECTRON_APP:path.join(distribution,'Electron.app'),REVA_PACKAGE_DIR:directory,REVA_NATIVE_HELPER:native}});
  apps[arch]=path.join(directory,'REVA Studio.app');
  // Package verification signs each thin candidate. Those per-architecture
  // resource seals differ; the owned merged bundle receives a fresh final seal.
  if(selected==='universal') {
   const stripSeals=async directory=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(!entry.isDirectory())continue;const child=path.join(directory,entry.name);if(entry.name==='_CodeSignature')await fs.rm(child,{recursive:true});else await stripSeals(child);}};
   await stripSeals(apps[arch]);
  }
 }
 const app=selected==='universal'?path.join(job,'universal/REVA Studio.app'):apps[selected];
 if(selected==='universal') {
  await makeUniversalApp({x64AppPath:apps.x64,arm64AppPath:apps.arm64,outAppPath:app});
  const identity=await resolveSigningIdentity(process.env.REVA_CODESIGN_IDENTITY,exec);
  await signApp(app,identity.identity,exec);
 }
 const expected=selected==='universal'?['x86_64','arm64']:[selected==='x64'?'x86_64':'arm64'];
 const binaries=['Contents/MacOS/Electron','Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework','Contents/Resources/app/native/build/reva-capture'];
 const architectureChecks=[];
 for(const file of binaries) {
  const {stdout}=await exec('/usr/bin/lipo',['-archs',path.join(app,file)]);
  const actual=stdout.trim().split(/\s+/);
  if(expected.some(arch=>!actual.includes(arch))) throw new Error(`Architecture missing from ${file}: ${actual}`);
  architectureChecks.push({file,architectures:actual});
 }
 for(const file of destinations) {try{await fs.access(file);throw new Error(`Release destination exists: ${file}`);}catch(error){if(error.code!=='ENOENT')throw error;}}
 const temporaryZip=path.join(job,'app.zip');
 await run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,temporaryZip]);
 await run('/usr/bin/unzip',['-tq',temporaryZip]);
 const imageRoot=path.join(job,'disk-image');await fs.mkdir(imageRoot);
 await run('/usr/bin/ditto',[app,path.join(imageRoot,'REVA Studio.app')]);
 await fs.symlink('/Applications',path.join(imageRoot,'Applications'));
 await fs.copyFile(path.join(root,'INSTALL.txt'),path.join(imageRoot,'INSTALL.txt'));
 const temporaryDmg=path.join(job,'release.dmg');
 await run('/usr/bin/hdiutil',['create','-volname','REVA Studio','-srcfolder',imageRoot,'-format','UDZO',temporaryDmg]);
 await run('/usr/bin/hdiutil',['verify',temporaryDmg]);
 await fs.link(temporaryZip,archive);await fs.link(temporaryDmg,diskImage);
 const released=[];
 for(const file of [archive,diskImage]){const bytes=await fs.readFile(file);released.push({name:path.basename(file),bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
 await fs.writeFile(path.join(output,`${prefix}.sha256`),released.map(file=>`${file.sha256}  ${file.name}`).join('\n')+'\n',{flag:'wx'});
 await fs.writeFile(path.join(output,`${prefix}.build.json`),JSON.stringify({version:info.version,platform:'darwin',arch:selected,minimumMacOS:'14.0',electron:info.devDependencies.electron,host:{platform:process.platform,arch:process.arch,release:os.release()},architectureChecks,signing:process.env.REVA_CODESIGN_IDENTITY?'configured certificate':'ad hoc; not notarized',dependencies:'FFmpeg/ffprobe must be installed separately',files:released},null,2)+'\n',{flag:'wx'});
 const installed=path.join(root,'build',`macOS-${selected}`);await fs.mkdir(installed,{recursive:true});
 await fs.rename(app,path.join(installed,'REVA Studio.app'));
 complete=true;console.log(`Release ready: ${output}`);
} finally {
 // Keep failed work for diagnosis rather than discard possible completed output.
 if(complete) await fs.rm(job,{recursive:true}); else console.error(`Release work retained at ${job}`);
}
