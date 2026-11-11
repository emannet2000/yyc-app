import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';
import { openStore, AppError, check } from './store.js';
const publicDir=resolve(dirname(fileURLToPath(import.meta.url)),'../public');
export function createApp({store=openStore(),secure=process.env.NODE_ENV==='production',publicOrigin=process.env.PUBLIC_ORIGIN||''}={}){
 if(secure){let origin;try{origin=new URL(publicOrigin);}catch{throw new Error('Production requires PUBLIC_ORIGIN set to the exact HTTPS browser origin.');}if(origin.protocol!=='https:'||origin.origin!==publicOrigin)throw new Error('Production PUBLIC_ORIGIN must be an origin such as https://broker.example.com, without a path.');}
 const attempts=new Map();
 function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
 function cookie(req){let m=(req.headers.cookie||'').match(/(?:^|;\s*)yyc_session=([a-f0-9]{64})(?:;|$)/);return m?.[1];}
 function setCookie(res,token,maxAge=43200){res.setHeader('Set-Cookie',`yyc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`);}
 async function body(req){check(req.headers['content-type']?.split(';')[0].trim()==='application/json',415,'Send application/json.');let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;check(size<=32768,413,'Request is too large.');chunks.push(chunk);}try{let result=JSON.parse(Buffer.concat(chunks).toString('utf8'));check(result&&typeof result==='object'&&!Array.isArray(result),400,'JSON object required.');return result;}catch(e){if(e instanceof AppError)throw e;throw new AppError(400,'Invalid JSON.');}}
 function origin(req){let expected=publicOrigin||`${secure?'https':'http'}://${req.headers.host}`;check(req.headers.origin===expected,403,'Request origin is not allowed.');check(!['cross-site'].includes(req.headers['sec-fetch-site']),403,'Cross-site requests are not allowed.');}
 function limit(req){let key=req.socket.remoteAddress||'local',now=Date.now(),entry=attempts.get(key);if(!entry||entry.until<now){if(attempts.size>10000){for(let [k,v]of attempts)if(v.until<now)attempts.delete(k);check(attempts.size<10000,429,'Try again later.');}entry={count:0,until:now+15*60000};attempts.set(key,entry);}check(++entry.count<=30,429,'Too many account attempts. Try again in 15 minutes.');}
 const server=http.createServer(async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Permissions-Policy','geolocation=(), camera=(), microphone=()');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");if(secure)res.setHeader('Strict-Transport-Security','max-age=31536000');try{
 let url=new URL(req.url,'http://localhost'),path=url.pathname;
 if(path==='/healthz'&&req.method==='GET'){store.db.prepare('SELECT 1').get();return json(res,200,{status:'ok',maps:false,gps:false});}
 if(path.startsWith('/api/')){
  const mutation=!['GET','HEAD'].includes(req.method);if(mutation)origin(req);
  if(path==='/api/register'&&req.method==='POST'){limit(req);let u=await store.createUser(await body(req));return json(res,201,{user:u,message:u.role==='driver'?'Registration saved. YYC approval is required.':'Store account created. Log in to continue.'});}
  if(path==='/api/login'&&req.method==='POST'){limit(req);let data=await body(req),u=await store.login(data.email,data.password),s=store.createSession(u.id);setCookie(res,s.token);return json(res,200,{user:store.publicUser(u),csrf:s.csrf});}
  const token=cookie(req),session=store.session(token);
  if(path==='/api/session'&&req.method==='GET')return json(res,200,{user:session?store.publicUser(session.user):null,csrf:session?.csrf||null});
  check(session,401,'Please log in.');if(mutation)check(req.headers['x-csrf-token']===session.csrf,403,'Your session token is missing or expired. Refresh and try again.');let u=session.user;
  if(path==='/api/logout'&&req.method==='POST'){store.logout(token);setCookie(res,'',0);return json(res,200,{ok:true});}
  if(path==='/api/state'&&req.method==='GET'){let limit=Number(url.searchParams.get('limit')||100),after=url.searchParams.get('after')||'';return json(res,200,store.state(u,{limit,after}));}
  if(path==='/api/profile'&&req.method==='PATCH')return json(res,200,{user:store.updateProfile(u,await body(req))});
  if(path==='/api/shipments'&&req.method==='POST')return json(res,201,{shipment:store.createShipment(u,await body(req))});
  let a=path.match(/^\/api\/shipments\/(YYC-\d+)\/actions$/);if(a&&req.method==='POST'){let data=await body(req);return json(res,200,{shipment:store.act(u,a[1],data.action,data)});}
  let d=path.match(/^\/api\/drivers\/([a-f0-9-]+)\/approve$/);if(d&&req.method==='POST'){await body(req);return json(res,200,{driver:store.approve(u,d[1])});}
  throw new AppError(404,'API endpoint not found.');
 }
 check(['GET','HEAD'].includes(req.method),405,'Method not allowed.');let filePath;try{let decoded=decodeURIComponent(path);check(!decoded.includes('\0')&&!decoded.includes('\\'),404,'Not found.');filePath=resolve(publicDir,'.'+(decoded==='/'?'/index.html':decoded==='/demo'||decoded==='/demo/'?'/demo/index.html':decoded));}catch(e){if(e instanceof AppError)throw e;throw new AppError(404,'Not found.');}
 check(filePath.startsWith(publicDir+sep),404,'Not found.');let types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};check(types[extname(filePath)],404,'Not found.');let content;try{check((await stat(filePath)).isFile(),404,'Not found.');content=await readFile(filePath);}catch{throw new AppError(404,'Not found.');}res.writeHead(200,{'Content-Type':types[extname(filePath)],'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
 }catch(e){if(res.headersSent){res.end();return}let status=e instanceof AppError?e.status:500;if(status===500)console.error('YYC request failed:',e.code||e.name);json(res,status,{error:status===500?'An unexpected server error occurred.':e.message});}});
 server.requestTimeout=15000;server.headersTimeout=10000;return {server,store};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){let option=name=>{let i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined};let port=Number(option('--port')||process.env.PORT||3000),host=option('--host')||process.env.HOST||'127.0.0.1';check(Number.isInteger(port)&&port>0&&port<65536,400,'PORT must be between 1 and 65535.');let {server,store}=createApp();server.on('error',err=>{console.error(err.code==='EADDRINUSE'?`Port ${port} is already in use. Try PORT=3001 npm start.`:'Server could not start: '+err.code);store.db.close();process.exitCode=1;});server.listen(port,host,()=>console.log(`YYC Brokers running at http://${host}:${port}\nCreate a broker account with: npm run setup-admin\nMaps, GPS, email and file uploads are not connected.`));let stopping=false;for(let sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{if(stopping)return;stopping=true;server.close(()=>{store.db.close();process.exit(0)});setTimeout(()=>process.exit(1),5000).unref();});}
