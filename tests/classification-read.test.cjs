const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { sourceFingerprintFromBson } = require('../dist/persistence/classificationSource.js');
const { fingerprintSourceOperation } = require('../dist/domain/classification/sourceFingerprint.js');
const { classificationReadiness } = require('../dist/persistence/classificationReadiness.js');
const { CLASSIFICATION_MANIFEST: manifest } = require('../dist/persistence/classificationManifest.js');
const owner = 'aaaaaaaaaaaaaaaaaaaaaaaa', id = '111111111111111111111111';
const identity = { owner, dataset:'expenses', operationId:id };
const facts = () => ({ amount:12.34, date:new Date(1736942400000), category:'Транспорт',title:'Fuel',recipient:'Synthetic station' });
const row = () => ({ _id:new mongoose.Types.ObjectId(id), owner:new mongoose.Types.ObjectId(owner), ...facts() });

describe('classification source projection boundary (no database)', () => {
  it('matches independent explicit domain projection without casting or trimming', () => {
    assert.deepEqual(sourceFingerprintFromBson(row(),identity),fingerprintSourceOperation({...identity,...facts()},1));
  });
  for (const [label, change] of [
    ['accessor', x=>Object.defineProperty(x,'amount',{get(){throw new Error('Forbidden getter');},enumerable:true})],
    ['toJSON', x=>({...x,toJSON(){throw new Error('Forbidden hook');}})],
    ['inherited facts', x=>Object.create(x)],
    ['wrong owner', x=>({...x,owner:new mongoose.Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb')})],
    ['wrong operation', x=>({...x,_id:new mongoose.Types.ObjectId('222222222222222222222222')})],
    ['string ID', x=>({...x,_id:id})],
    ['coerced amount', x=>({...x,amount:'12.34'})],
    ['decimal amount', x=>({...x,amount:mongoose.mongo.BSON.Decimal128.fromString('12.34')})],
    ['long amount', x=>({...x,amount:mongoose.mongo.BSON.Long.fromNumber(12)})],
    ['invalid date', x=>({...x,date:new Date(NaN)})],
    ['missing required string', x=>{delete x.title;return x;}],
    ['unexpected field', x=>({...x,extra:true})],
    ['cross dataset field', x=>({...x,source:'Salary'})],
    ['undefined comment', x=>({...x,comment:undefined})],
  ]) it('rejects '+label+' safely',()=>assert.equal(sourceFingerprintFromBson(change(row()),identity).ok,false));
  it('preserves absent/null/empty comments and exact Unicode strings',()=>{
    const variants=[row(),{...row(),comment:null},{...row(),comment:''},{...row(),comment:'é'},{...row(),comment:'e\u0301'}];
    assert.equal(new Set(variants.map(x=>sourceFingerprintFromBson(x,identity).value.sourceFingerprint)).size,5);
  });
  it('does not mutate its source or identity',()=>{
    const x=Object.freeze(row()), before=mongoose.mongo.BSON.serialize(x);
    assert.equal(sourceFingerprintFromBson(x,Object.freeze(identity)).ok,true);
    assert.equal(mongoose.mongo.BSON.serialize(x).equals(before),true);
  });
});

describe('manifest inspection fails closed (no database)',()=>{
  const metadata=()=>({name:manifest.collectionName,type:'collection',options:structuredClone(manifest.options)});
  const index=()=>({key:{...manifest.index.key},...structuredClone(manifest.index.options)});
  const inspect=(collections,indexes)=>classificationReadiness({
    listCollections:()=>({toArray:async()=>collections}), collection:()=>({listIndexes:()=>({toArray:async()=>indexes})}),
  });
  it('accepts the exact manifest and omitted Mongo simple/false defaults',async()=>{
    assert.equal(await inspect([metadata()],[index()]),true);
    const c=metadata(),i=index(); delete c.options.collation; delete i.collation;delete i.sparse;
    assert.equal(await inspect([c],[i]),true);
  });
  it('rejects missing collection and missing index',async()=>{
    assert.equal(await inspect([],[]),false);assert.equal(await inspect([metadata()],[]),false);
  });
  for(const [label,change] of [
    ['validator',c=>{c.options.validator={};}],['warn mode',c=>{c.options.validationAction='warn';}],
    ['moderate validation',c=>{c.options.validationLevel='moderate';}],['view',c=>{c.type='view';}],
    ['capped collection',c=>{c.options.capped=true;}],['collation',c=>{c.options.collation={locale:'en'};}],
  ]) it('rejects '+label,async()=>{const c=metadata();change(c);assert.equal(await inspect([c],[index()]),false);});
  for(const [label,change] of [
    ['nonunique',i=>{i.unique=false;}],['sparse',i=>{i.sparse=true;}],['partial',i=>{i.partialFilterExpression={state:'approved'};}],
    ['TTL',i=>{i.expireAfterSeconds=10;}],['hidden',i=>{i.hidden=true;}],['wrong order',i=>{i.key={dataset:1,owner:1,operationId:1};}],
    ['wrong name',i=>{i.name='other';}],['collated index',i=>{i.collation={locale:'en'};}],
  ]) it('rejects '+label+' index',async()=>{const i=index();change(i);assert.equal(await inspect([metadata()],[i]),false);});
});

describe('compiled classification HTTP auth/input/gate contracts (database forbidden)',{concurrency:false,timeout:15000},()=>{
  let server,sandbox,cwd,saved,loggers=[],opened=[],streams=[],fileClosed=[],guards=[];
  const names=['NODE_ENV','JWT_SECRET','CLASSIFICATION_READ_ENABLED'];
  const token=payload=>jwt.sign(payload,'super-secret-key');
  const endpoint='/classifications/expenses/'+id;
  const request=(path=endpoint,credential=token({_id:owner}),body,headers={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,method:'GET',path,
      headers:{Connection:'close',...(credential?{Authorization:'Bearer '+credential}:{}),...headers}},res=>{
      let data='';res.on('data',x=>{data+=x;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data),headers:res.headers}));
    });req.on('error',()=>reject(new Error('Synthetic HTTP request failed')));req.setTimeout(3000,()=>req.destroy());req.end(body);
  });
  before(async()=>{
    cwd=process.cwd();saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));
    sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'classification-read-'));process.chdir(sandbox);
    process.env.NODE_ENV='test';delete process.env.JWT_SECRET;delete process.env.CLASSIFICATION_READ_ENABLED;
    for(const [target,method] of [[mongoose,'connect'],[mongoose,'createConnection'],[mongoose.Query.prototype,'exec'],
      [mongoose.Connection.prototype,'openUri'],[mongoose.mongo.MongoClient.prototype,'connect']]) guards.push(mock.method(target,method,()=>{throw new Error('Database forbidden');}));
    const winston=require('winston'),create=winston.createLogger,write=fs.createWriteStream;
    mock.method(winston,'createLogger',function(...args){const l=Reflect.apply(create,this,args);l.silent=true;loggers.push(l);
      for(const t of l.transports)opened.push(once(t,'open'));return l;});
    mock.method(fs,'createWriteStream',function(...args){const s=Reflect.apply(write,this,args);streams.push(s);fileClosed.push(once(s,'close'));return s;});
    const net=require('node:net');const guard=mock.method(net.Server.prototype,'listen',()=>{throw new Error('Import-time listen forbidden');});
    let app;try{app=require('../dist/app.js');}finally{guard.mock.restore();}
    assert.equal(require.cache[require.resolve('../dist/server.js')],undefined);
    server=app.listen(0,'127.0.0.1');await once(server,'listening');await Promise.all(opened);
    guards.push(mock.method(mongoose.mongo.Db.prototype,'collection',()=>{throw new Error('Database forbidden');}));
  });
  after(async()=>{
    try {
      if(server){server.closeAllConnections();await new Promise((r,j)=>server.close(e=>e?j(e):r()));}
      await Promise.all(opened);const closed=loggers.flatMap(l=>l.transports.map(t=>once(t,'closed')));loggers.forEach(l=>l.close());
      await Promise.all([...closed,...fileClosed]);streams.forEach(s=>assert.equal(s.closed,true));
      guards.forEach(g=>assert.equal(g.mock.callCount(),0));
    }finally{mock.restoreAll();for(const n of names){if(saved[n]===undefined)delete process.env[n];else process.env[n]=saved[n];}
      process.chdir(cwd);fs.rmSync(sandbox,{recursive:true,force:true});}
  });
  it('requires JWT before the disabled gate',async()=>assert.equal((await request(endpoint,'')).status,401));
  for(const [label,credential] of [['invalid signature',jwt.sign({_id:owner},'wrong')],['missing owner',token({})],
    ['nonstring owner',token({_id:{id:owner}})],['trailing newline owner',token({_id:owner+'\n'})]])
    it('rejects '+label,async()=>assert.equal((await request(endpoint,credential)).status,401));
  for(const [label,url] of [['dataset','/classifications/unknown/'+id],['short ID','/classifications/expenses/123'],
    ['newline ID',endpoint+'%0A'],['nonhex ID','/classifications/expenses/'+'z'.repeat(24)],
    ['query owner',endpoint+'?owner='+owner],['unknown query',endpoint+'?extra=1']])
    it('rejects invalid '+label+' before database access',async()=>assert.equal((await request(url)).status,400));
  it('rejects body identity rather than using it',async()=>assert.equal((await request(endpoint,token({_id:owner}),'{"owner":"'+owner+'"}',
    {'Content-Type':'application/json','Content-Length':Buffer.byteLength('{"owner":"'+owner+'"}') })).status,400));
  it('rejects an empty array body and ignores spoofed custom owner headers',async()=>{
    assert.equal((await request(endpoint,token({_id:owner}),'[]',{'Content-Type':'application/json','Content-Length':2})).status,400);
    const res=await request(endpoint,token({_id:owner}),undefined,{'X-Owner-Id':'bbbbbbbbbbbbbbbbbbbbbbbb'});
    assert.equal(res.status,503);
  });
  it('sanitizes unexpected internal boundary failures',async()=>{
    const handler=require('../dist/controllers/classificationRead.js');let status,body;
    const user=new Proxy({},{getOwnPropertyDescriptor(){throw new Error('Fictional private failure');}});
    await handler({user},{set(){},status(x){status=x;return this;},json(x){body=x;}});
    assert.equal(status,500);assert.deepEqual(body,{message:'Classification read failed'});
  });
  for(const value of [undefined,'0','true',' 1','1 ']) it('is disabled for nonexact gate '+String(value),async()=>{
    if(value===undefined)delete process.env.CLASSIFICATION_READ_ENABLED;else process.env.CLASSIFICATION_READ_ENABLED=value;
    const res=await request();assert.equal(res.status,503);assert.deepEqual(res.body,{message:'Classification reads unavailable'});
    assert.equal(res.headers['cache-control'],'no-store');
  });
  it('does not buffer reads when explicitly enabled without a connection',async()=>{
    process.env.CLASSIFICATION_READ_ENABLED='1';assert.equal((await request()).status,503);
  });
  it('rejects invalid principal at the controller boundary',async()=>{
    const handler=require('../dist/controllers/classificationRead.js');let status,body;
    for(const user of [{},Object.assign([],{_id:owner}),null]){
      await handler({user,params:{dataset:'expenses',operationId:id},query:{}},{set(){},status(x){status=x;return this;},json(x){body=x;}});
      assert.equal(status,401);assert.deepEqual(body,{message:'Необходима авторизация.'});
    }
  });
});
