import { DatabaseSync,backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdirSync,existsSync,chmodSync } from 'node:fs';
const source=resolve(process.env.YYC_DATA_DIR||'data','yyc.sqlite');if(!existsSync(source)){console.error('No database exists yet. Start the app first.');process.exit(1);}const directory=resolve('backups');mkdirSync(directory,{recursive:true,mode:0o700});const target=resolve(directory,'yyc-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,target);chmodSync(target,0o600);console.log('Backup created: '+target);}finally{db.close();}
