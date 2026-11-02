'use strict';
// Controlled, local-only source editor: project-scoped files, optimistic locking and backups.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {TextDecoder}=require('node:util');
const EXTS=new Set(['.rs','.js','.ts','.jsx','.tsx','.json','.toml']);
const IGNORED=new Set(['node_modules','.git','target','dist','build','out','coverage','.next','.turbo','vendor']);
const MAX_FILE=1_000_000,MAX_ENTRIES=8000,MAX_FILES=400;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function safeRelative(rel){
 if(typeof rel!=='string'||rel.length>500||!rel||path.isAbsolute(rel)||rel.includes('\0'))
  throw Error('Invalid project file selection.');
 const bits=rel.replace(/\\/g,'/').split('/');
 if(bits.some(x=>!x||x==='.'||x==='..'||IGNORED.has(x)))throw Error('File path is outside the editable source set.');
 if(!EXTS.has(path.extname(rel).toLowerCase()))throw Error('Only source code and project configuration can be edited.');
 return bits;
}
async function rootDirectory(folder){
 const root=await fs.realpath(folder);
 if(!(await fs.stat(root)).isDirectory())throw Error('Select a project directory, not a file.');
 const cargo=await fs.stat(path.join(root,'Cargo.toml')).catch(()=>null);
 const pkg=await fs.stat(path.join(root,'package.json')).catch(()=>null);
 if(!cargo?.isFile()&&!pkg?.isFile())throw Error('Choose a folder containing Cargo.toml or package.json.');
 return {root,kind:cargo?.isFile()?'rust':'javascript'};
}
async function resolveFile(project,rel){
 const bits=safeRelative(rel);
 const full=path.join(project.root,...bits);
 const real=await fs.realpath(full);
 const root=process.platform==='win32'?project.root.toLowerCase():project.root;
 const test=process.platform==='win32'?real.toLowerCase():real;
 if(!test.startsWith(root+path.sep))throw Error('Source file escapes the selected project.');
 const lst=await fs.lstat(full);
 if(!lst.isFile()||lst.isSymbolicLink())throw Error('Symlinks and special files cannot be edited.');
 const st=await fs.stat(real);
 if(!st.isFile()||st.size>MAX_FILE)throw Error('Source file exceeds 1 MB or is not a regular file.');
 return {full,real,st};
}
async function openProject(folder){
 const project=await rootDirectory(folder);
 const list=[];let scanned=0;
 async function walk(dir,depth){
  if(depth>7)return;
  const items=await fs.readdir(dir,{withFileTypes:true});
  for(const item of items){
   if(++scanned>MAX_ENTRIES)throw Error('Project contains too many files to scan safely.');
   if(item.isSymbolicLink()||IGNORED.has(item.name))continue;
   const full=path.join(dir,item.name);
   if(item.isDirectory())await walk(full,depth+1);
   else if(item.isFile()&&EXTS.has(path.extname(item.name).toLowerCase())){
    if((await fs.stat(full)).size<=MAX_FILE){
     list.push(path.relative(project.root,full).replace(/\\/g,'/'));
     if(list.length>MAX_FILES)throw Error('Too many editable source files (limit 400).');
    }
   }
  }
 }
 await walk(project.root,0);
 list.sort((a,b)=>{
  const score=x=>x==='src/lib.rs'||x==='src/index.ts'||x==='src/contract.ts'||x==='src/index.js'||x==='src/contract.js'?0:x.startsWith('src/')?1:2;
  return score(a)-score(b)||a.localeCompare(b);
 });
 return {...project,files:list};
}
async function readSource(project,rel){
 const {real}=await resolveFile(project,rel);
 const data=await fs.readFile(real);
 if(data.includes(0))throw Error('Binary files cannot be edited as source text.');
 let content;
 try{content=new TextDecoder('utf-8',{fatal:true}).decode(data);}
 catch{throw Error('Source file is not valid UTF-8.');}
 return {file:rel,text:content,hash:digest(data),bytes:data.length};
}
async function saveSource(project,rel,content,expectedHash,userData){
 if(typeof content!=='string'||content.length>MAX_FILE||content.includes('\0'))
  throw Error('Source text must be valid and no larger than 1 MB.');
 if(!/^[a-f0-9]{64}$/.test(expectedHash||''))throw Error('Reload the source file before saving.');
 const {real,st}=await resolveFile(project,rel);
 const old=await fs.readFile(real);
 if(digest(old)!==expectedHash)throw Error('The file changed on disk. Reload it before saving to prevent overwriting another change.');
 const bytes=Buffer.from(content,'utf8');
 if(bytes.length>MAX_FILE)throw Error('Edited source exceeds the 1 MB limit.');
 if(Buffer.compare(bytes,old)===0)return {file:rel,hash:digest(old),unchanged:true,backup:null};
 const backups=path.join(userData,'source-backups',digest(Buffer.from(project.root)).slice(0,16));
 await fs.mkdir(backups,{recursive:true,mode:0o700});
 const backup=path.join(backups,Date.now()+'-'+randomUUID()+'-'+path.basename(real)+'.bak');
 await fs.writeFile(backup,old,{flag:'wx',mode:0o600});
 const temp=path.join(path.dirname(real),'.forge-edit-'+randomUUID()+'.tmp');
 try{
  await fs.writeFile(temp,bytes,{flag:'wx',mode:st.mode&0o777});
  // Recheck immediately before replacement, including symbolic link substitution.
  if((await fs.realpath(real))!==real||digest(await fs.readFile(real))!==expectedHash)
   throw Error('Source file changed during save. Backup retained; file not overwritten.');
  await fs.rename(temp,real);
 }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
 return {file:rel,hash:digest(bytes),unchanged:false,backup,path:real};
}
module.exports={openProject,readSource,saveSource,safeRelative,resolveFile,digest,MAX_FILE};
