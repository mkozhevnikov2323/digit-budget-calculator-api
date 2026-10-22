const {describe,it,before,beforeEach,after,mock}=require('node:test');
const assert=require('node:assert/strict');
const jwt=require('jsonwebtoken');
const {createHarness,testConfiguration}=require('./helpers/mongodb-integration.cjs');
const {input,omit}=require('./helpers/classification-fixtures.cjs');
const a='a'.repeat(24),b='b'.repeat(24),id='1'.repeat(24),foreign='2'.repeat(24),missing='9'.repeat(24);
const token=(owner=a,exp=4102444800)=>jwt.sign({_id:owner,...(exp===null?{}:{exp})},'super-secret-key');
describe('P5 real coherent batch HTTP with isolated MongoDB',{concurrency:false,timeout:120000},()=>{
  let h,db,manifest,prepare,fingerprint,saved;
  const oid=x=>new h.mongoose.Types.ObjectId(x);
  const facts=(dataset='expenses',owner=a,operationId=id)=>({_id:oid(operationId),owner:oid(owner),amount:12.34,date:new Date(1736942400001),
    ...(dataset==='expenses'?{category:'Транспорт',title:'Fuel',recipient:'Fictional station'}:{source:'Fictional salary'})});
  const request=(operations=[{dataset:'expenses',operationId:id}],extra={})=>({version:'classification-history-read-request-v1',
    startInclusive:1735689600000,endExclusive:1767225600000,operations,...extra});
  const post=(body=request(),credential=token(),options)=>h.request('POST','/classifications/history/read',body,credential,options);
  const decision=async(state='approved',dataset='expenses')=>{
    const digest=fingerprint(facts(dataset),{owner:a,dataset,operationId:id});assert.equal(digest.ok,true);
    let x=input({owner:a,dataset,operationId:id,state,...digest.value,assignment:dataset==='expenses'
      ?{economicRole:'ordinary_expense',layer:'everyday'}:{economicRole:'ordinary_income',layer:null}});
    if(state!=='approved')x=omit(x,'assignment');const p=prepare(x);assert.equal(p.ok,true);h.assertDatabase();
    await db.collection(manifest.collectionName).insertOne(p.value);
  };
  const snapshot=async()=>{h.assertDatabase();return Promise.all(['expenses','incomes',manifest.collectionName].map(async name=>
    (await db.collection(name).find({}).sort({_id:1}).toArray()).map(x=>h.mongoose.mongo.BSON.serialize(x).toString('hex'))));};
  before(async()=>{
    testConfiguration(process.env);saved=process.env.CLASSIFICATION_HISTORY_READ_ENABLED;
    h=await createHarness(process.env);db=h.mongoose.connection.db;
    ({CLASSIFICATION_MANIFEST:manifest}=require('../dist/persistence/classificationManifest'));
    ({prepareClassificationDocument:prepare}=require('../dist/persistence/classification'));
    ({sourceFingerprintFromBson:fingerprint}=require('../dist/persistence/classificationSource'));
  });
  beforeEach(async()=>{
    process.env.CLASSIFICATION_HISTORY_READ_ENABLED='1';h.assertDatabase();
    for(const name of ['expenses','incomes','users'])await db.collection(name).deleteMany({});
    await db.collection('users').insertMany([{_id:oid(a)},{_id:oid(b)}]);
    for(const dataset of ['expenses','incomes'])await db.collection(dataset).insertMany([facts(dataset),facts(dataset,b,foreign)]);
    if(await db.listCollections({name:manifest.collectionName}).hasNext())await db.collection(manifest.collectionName).drop();
    await db.createCollection(manifest.collectionName,manifest.options);await db.collection(manifest.collectionName).createIndex(manifest.index.key,manifest.index.options);
  });
  after(async()=>{
    mock.restoreAll();if(saved===undefined)delete process.env.CLASSIFICATION_HISTORY_READ_ENABLED;else process.env.CLASSIFICATION_HISTORY_READ_ENABLED=saved;
    if(h){assert.deepEqual(await h.close(),{dropped:true,disconnected:true,listenerClosed:true,logsClosed:true,directoryRemoved:true,environmentRestored:true});
      console.info('Coherent history test-owned MongoDB dropped and verified empty; HTTP/logs/environment released.');}
  });
  it('returns same-source owned facts and unreviewed status without private metadata',async()=>{
    const before=await snapshot(),r=await post();assert.equal(r.status,200);assert.equal(r.body.returnedCount,1);
    assert.equal(r.body.operations[0].classification.status,'unreviewed');assert.equal(r.body.operations[0].facts.amount.value,'12.34');
    assert.equal(r.body.operations[0].facts.dateEpochMs,1736942400001);assert.equal(r.body.consistency,'observed_only_non_atomic');
    for(const key of ['sourceFingerprint','lastMutation','credentialBinding','stack','owner'])assert.equal(r.text.includes('"'+key+'"'),false,'Private metadata excluded');
    assert.deepEqual(await snapshot(),before);
  });
  for(const dataset of ['expenses','incomes'])for(const state of ['approved','explicit_unclassified','cleared'])it(dataset+' '+state+' observation',async()=>{
    await decision(state,dataset);const r=await post(request([{dataset,operationId:id}]));assert.equal(r.status,200);
    assert.equal(r.body.operations[0].classification.status,state);
  });
  it('source edits yield stale against the exact returned facts',async()=>{
    await decision();await db.collection('expenses').updateOne({_id:oid(id)},{$set:{amount:77}});
    const r=await post();assert.equal(r.status,200);assert.equal(r.body.operations[0].facts.amount.value,'77');
    assert.equal(r.body.operations[0].classification.status,'stale');assert.equal(r.body.operations[0].classification.confirmed,null);
  });
  it('malformed stored classification yields blocked without partial metadata',async()=>{
    await decision();await db.collection(manifest.collectionName).updateOne({owner:oid(a)},{$set:{taxonomyVersion:'unknown'}},{bypassDocumentValidation:true});
    const r=await post();assert.equal(r.status,200);assert.equal(r.body.operations[0].classification.status,'blocked');
    assert.equal(r.body.operations[0].classification.decisionRevision,null);
  });
  it('foreign/missing/deleted identities have identical uniform failures, including mixed batches',async()=>{
    const values=[];for(const op of [foreign,missing])values.push(await post(request([{dataset:'expenses',operationId:op}])));
    await db.collection('expenses').deleteOne({_id:oid(id)});values.push(await post());
    for(const r of values){assert.equal(r.status,404);assert.deepEqual(r.body,{code:'source_not_found'});}
  });
  for(const kind of ['missing','expired','absent exp','deleted account'])it('rejects '+kind+' credentials before financial reads',async()=>{
    let credential=token();if(kind==='missing')credential='';if(kind==='expired')credential=token(a,1);if(kind==='absent exp')credential=token(a,null);
    if(kind==='deleted account')await db.collection('users').deleteOne({_id:oid(a)});
    let financialReads=0;
    const original=h.mongoose.mongo.Collection.prototype.find,spy=mock.method(h.mongoose.mongo.Collection.prototype,'find',function(...args){
      if(['expenses','incomes',manifest.collectionName].includes(this.collectionName)){financialReads++;throw Error('Forbidden read');}
      return Reflect.apply(original,this,args);});
    try{assert.equal((await post(request(),credential)).status,401);assert.equal(financialReads,0);}finally{spy.mock.restore();}
  });
  it('disabled gate performs no database access and does not alter existing GET gate',async()=>{
    delete process.env.CLASSIFICATION_HISTORY_READ_ENABLED;const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',()=>{throw Error('Forbidden');});
    try{assert.equal((await post()).status,503);assert.equal(spy.mock.callCount(),0);}finally{spy.mock.restore();}
  });
  it('supports 100 identities and rejects 101, duplicates, caller owner and empty sets',async()=>{
    const operations=Array.from({length:100},(_,n)=>({dataset:'expenses',operationId:(n+100).toString(16).padStart(24,'0')}));
    await db.collection('expenses').insertMany(operations.map(op=>facts('expenses',a,op.operationId)));
    const r=await post(request(operations));assert.equal(r.status,200);assert.equal(r.body.operations.length,100);
    for(const body of [request([...operations,{dataset:'expenses',operationId:missing}]),request([operations[0],operations[0]]),request([]),request(undefined,{owner:b})])
      assert.equal((await post(body)).status,400);
  });
  for(const rawBody of ['{"version":1,"version":2}','{"version":1,"\\u0076ersion":2}','{"invalid":'])it('rejects malformed/duplicate raw JSON safely',async()=>{
    const r=await post(undefined,token(),{rawBody});assert.equal(r.status,400);assert.deepEqual(r.body,{code:'invalid_request'});
  });
  it('enforces no-store, no ETag, Origin, JSON and decoded-size bounds on all outcomes',async()=>{
    for(const [options,status] of [[{},200],[{headers:{Origin:'https://foreign.invalid'}},403],[{headers:{Origin:'null'}},403],
      [{headers:{'Content-Type':'text/plain'}},415],[{rawBody:JSON.stringify({padding:'x'.repeat(8200)})},413]]){
      const r=await post(request(),token(),options);assert.equal(r.status,status);assert.equal(r.headers['cache-control'],'no-store');
      assert.equal(r.headers.etag,undefined);assert.equal(r.headers.vary.includes('Authorization'),true);assert.equal(r.headers.vary.includes('Origin'),true);
    }
  });
  for(const comment of [undefined,null,'','é','e\u0301'])it('preserves exact comment representation '+String(comment===undefined?'absent':comment===null?'null':comment.length),async()=>{
    if(comment!==undefined)await db.collection('expenses').updateOne({_id:oid(id)},{$set:{comment}});
    const r=await post();assert.equal(r.status,200);const c=r.body.operations[0].facts.comment;
    assert.deepEqual(c,comment===undefined?{kind:'missing'}:comment===null?{kind:'null'}:{kind:'value',value:comment});
  });
  for(const amount of [-0,0.1+0.2])it('preserves binary64 wire fact without rounding '+String(Object.is(amount,-0)?'negative zero':'fraction'),async()=>{
    await db.collection('expenses').updateOne({_id:oid(id)},{$set:{amount:new h.mongoose.mongo.BSON.Double(amount)}});
    const r=await post();assert.equal(r.status,200);assert.equal(Object.is(Number(r.body.operations[0].facts.amount.value),amount),true);
  });
  it('out-of-window edits invalidate the batch',async()=>{
    await db.collection('expenses').updateOne({_id:oid(id)},{$set:{date:new Date(1767225600000)}});assert.equal((await post()).status,409);
  });
  it('missing readiness fails without installing anything',async()=>{
    await db.collection(manifest.collectionName).drop();assert.equal((await post()).status,503);
    assert.equal(await db.listCollections({name:manifest.collectionName}).hasNext(),false);
  });
  it('never executes DML/DDL during a read',async()=>{
    const spies=[];for(const method of ['insertOne','updateOne','replaceOne','deleteOne','bulkWrite','createIndex','drop'])
      spies.push(mock.method(h.mongoose.mongo.Collection.prototype,method,()=>{throw Error('Forbidden write');}));
    try{assert.equal((await post()).status,200);for(const spy of spies)assert.equal(spy.mock.callCount(),0);}finally{spies.forEach(s=>s.mock.restore());}
  });
  for(const mutation of ['PATCH','DELETE'])it('documents observed-only concurrent '+mutation+' without mixing snapshots',async()=>{
    await decision();let changed=false;const original=h.mongoose.mongo.Collection.prototype.find;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'find',function(...args){
      const cursor=Reflect.apply(original,this,args);
      if(this.collectionName==='expenses'){
        const toArray=cursor.toArray.bind(cursor);cursor.toArray=async()=>{const rows=await toArray();if(!changed){changed=true;
          if(mutation==='PATCH')await db.collection('expenses').updateOne({_id:oid(id)},{$set:{amount:88}});else await db.collection('expenses').deleteOne({_id:oid(id)});}return rows;};
      }return cursor;
    });
    try{const r=await post();assert.equal(r.status,200);assert.equal(r.body.operations[0].facts.amount.value,'12.34');
      assert.equal(r.body.operations[0].classification.status,'approved');assert.equal(changed,true);}finally{spy.mock.restore();}
    assert.equal((await post()).status,mutation==='DELETE'?404:200);
  });
  it('sanitizes driver failures without financial output',async()=>{
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'find',()=>{throw Error('Fictional private driver marker');});
    try{const r=await post();assert.equal(r.status,503);assert.deepEqual(r.body,{code:'history_unavailable'});}finally{spy.mock.restore();}
  });
});
