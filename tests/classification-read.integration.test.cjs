const { describe,it,before,beforeEach,after,mock }=require('node:test');
const assert=require('node:assert/strict');
const { isDeepStrictEqual }=require('node:util');
const jwt=require('jsonwebtoken');
const { createHarness,testConfiguration }=require('./helpers/mongodb-integration.cjs');
const { input,omit }=require('./helpers/classification-fixtures.cjs');
const a='aaaaaaaaaaaaaaaaaaaaaaaa',b='bbbbbbbbbbbbbbbbbbbbbbbb';
const operationId='111111111111111111111111',missing='999999999999999999999999';
const token=owner=>jwt.sign({_id:owner,exp:4102444800},'super-secret-key');

describe('real MongoDB owner-scoped classification read API',{concurrency:false,timeout:120000},()=>{
  let h,db,manifest,prepare,fingerprint,originalGate;
  const oid=id=>new h.mongoose.Types.ObjectId(id);
  const collection=()=>db.collection(manifest.collectionName);
  const facts=(dataset='expenses',owner=a,id=operationId)=>({_id:oid(id),owner:oid(owner),amount:12.34,
    date:new Date(1736942400000),...(dataset==='expenses'?{category:'Транспорт',title:'Fuel',recipient:'Fictional station'}:{source:'Synthetic salary'}),
    comment:'Fictional private comment',__v:0,createdAt:new Date(1736942400001),updatedAt:new Date(1736942400001)});
  const snapshots=async()=>{
    h.assertDatabase();
    return Promise.all(['expenses','incomes',manifest.collectionName].map(async name=>
      (await db.collection(name).find({}).sort({_id:1}).toArray()).map(x=>h.mongoose.mongo.BSON.serialize(x))));
  };
  const rawGet=(owner=a,dataset='expenses',id=operationId)=>h.request('GET','/classifications/'+dataset+'/'+id,undefined,token(owner));
  const get=async(owner=a,dataset='expenses',id=operationId)=>{
    const before=await snapshots(),res=await rawGet(owner,dataset,id);
    assert.equal(isDeepStrictEqual(await snapshots(),before),true,'GET must preserve complete source and classification BSON');
    return res;
  };
  const expectState=(res,status,storedState=status,revision=1)=>{
    assert.equal(res.status,200);
    assert.deepEqual(Object.keys(res.body).sort(),['version','dataset','operationId','status','storedState','decisionRevision','confirmed','consistency'].sort());
    assert.equal(res.body.version,'classification-read-v1');assert.equal(res.body.consistency,'observed_only_non_atomic');
    assert.equal(res.body.status,status);assert.equal(res.body.storedState,storedState);assert.equal(res.body.decisionRevision,revision);
    if(status!=='approved')assert.equal(res.body.confirmed,null);
    // Boolean assertions only: private synthetic values must never be printed on failure.
    const text=JSON.stringify(res.body);
    for(const marker of ['sourceFingerprint','lastMutation','owner','amount','date"','comment','title','recipient','Fictional','12.34'])
      assert.equal(text.includes(marker),false,'Read DTO contains forbidden data');
  };
  const install=async(options=manifest.options,indexOptions=manifest.index.options)=>{
    h.assertDatabase();await db.createCollection(manifest.collectionName,options);
    if(indexOptions){h.assertDatabase();await collection().createIndex(manifest.index.key,indexOptions);}
  };
  const drop=async()=>{h.assertDatabase();if(await db.listCollections({name:manifest.collectionName}).hasNext())await collection().drop();};
  const decision=async(extra={},dataset='expenses',owner=a,id=operationId)=>{
    h.assertDatabase();const f=await db.collection(dataset).findOne({_id:oid(id),owner:oid(owner)},
      {projection:{_id:1,owner:1,amount:1,date:1,comment:1,...(dataset==='expenses'?{category:1,title:1,recipient:1}:{source:1})}});
    const digest=fingerprint(f,{owner,dataset,operationId:id});assert.equal(digest.ok,true,'Synthetic source must validate');
    let value=input({owner,dataset,operationId:id,...digest.value,
      assignment:dataset==='expenses'?{economicRole:'ordinary_expense',layer:'everyday'}:{economicRole:'ordinary_income',layer:null},...extra});
    if(value.state!=='approved')value=omit(value,'assignment');
    const prepared=prepare(value);assert.equal(prepared.ok,true,'Synthetic classification must validate');
    h.assertDatabase();await collection().insertOne(prepared.value);return prepared.value;
  };
  const editSource=async(change,dataset='expenses',id=operationId)=>{
    h.assertDatabase();await db.collection(dataset).updateOne({_id:oid(id),owner:oid(a)},{$set:change});
  };
  before(async()=>{
    testConfiguration(process.env);originalGate=process.env.CLASSIFICATION_READ_ENABLED;
    h=await createHarness(process.env);db=h.mongoose.connection.db;
    ({CLASSIFICATION_MANIFEST:manifest}=require('../dist/persistence/classificationManifest.js'));
    ({prepareClassificationDocument:prepare}=require('../dist/persistence/classification.js'));
    ({sourceFingerprintFromBson:fingerprint}=require('../dist/persistence/classificationSource.js'));
  });
  beforeEach(async()=>{
    process.env.CLASSIFICATION_READ_ENABLED='1';h.assertDatabase();
    for(const name of ['expenses','incomes']){h.assertDatabase();await db.collection(name).deleteMany({});
      await db.collection(name).insertMany([facts(name),facts(name,b,'222222222222222222222222')]);}
    await drop();await install();
  });
  after(async()=>{
    mock.restoreAll();if(originalGate===undefined)delete process.env.CLASSIFICATION_READ_ENABLED;else process.env.CLASSIFICATION_READ_ENABLED=originalGate;
    if(!h)return;
    assert.deepEqual(await h.close(),{dropped:true,disconnected:true,listenerClosed:true,logsClosed:true,directoryRemoved:true,environmentRestored:true});
    console.info('Classification read test-owned MongoDB dropped and verified empty; HTTP/logs/environment released.');
  });
  it('requires missing/invalid JWT before reads',async()=>{
    for(const credential of [undefined,'invalid',jwt.sign({_id:a},'wrong'),token({id:a})]){
      const res=await h.request('GET','/classifications/expenses/'+operationId,undefined,credential);assert.equal(res.status,401);
    }
  });
  it('rejects request dataset/ID/query/body without changing records',async()=>{
    for(const path of ['/classifications/unknown/'+operationId,'/classifications/expenses/not-an-id',
      '/classifications/expenses/'+operationId+'?owner='+b,'/classifications/expenses/'+operationId+'?unexpected=1'])
      assert.equal((await h.request('GET',path,undefined,token(a))).status,400);
    assert.equal((await h.request('GET','/classifications/expenses/'+operationId,{owner:b},token(a))).status,400);
  });
  it('foreign, deleted and missing sources have identical safe 404 responses without orphan disclosure',async()=>{
    await decision();const foreign=await get(b),absent=await get(a,'expenses',missing);
    h.assertDatabase();await db.collection('expenses').deleteOne({_id:oid(operationId),owner:oid(a)});
    const deleted=await get();assert.equal(deleted.status,404);assert.deepEqual(deleted.body,{message:'Operation not found'});
    assert.equal(foreign.status,404);assert.equal(absent.status,404);assert.deepEqual(foreign.body,deleted.body);assert.deepEqual(absent.body,deleted.body);
  });
  it('does not inspect classification readiness or records before ownership',async()=>{
    const spy=mock.method(db,'listCollections',()=>{throw new Error('No classification inspection allowed');});
    try{assert.equal((await rawGet(b)).status,404);assert.equal(spy.mock.callCount(),0);}finally{spy.mock.restore();}
  });
  it('returns unreviewed only after exact collection installation',async()=>expectState(await get(),'unreviewed',null,null));
  for(const dataset of ['expenses','incomes'])it('returns fresh approved '+dataset+' with minimal confirmed assignment',async()=>{
    await decision({},dataset);const res=await get(a,dataset);expectState(res,'approved');assert.equal(res.body.dataset,dataset);
    assert.deepEqual(res.body.confirmed,dataset==='expenses'?{economicRole:'ordinary_expense',layer:'everyday'}:{economicRole:'ordinary_income',layer:null});
  });
  for(const state of ['explicit_unclassified','cleared']){
    it('returns fresh '+state+' without confirmed assignment',async()=>{await decision({state});expectState(await get(),state);});
    it('preserves underlying '+state+' on stale facts',async()=>{await decision({state});await editSource({amount:19});expectState(await get(),'stale',state);});
  }
  for(const [label,change,dataset] of [
    ['amount',{amount:12.340000000000002},'expenses'],['date',{date:new Date(1736942400001)},'expenses'],
    ['category',{category:'Other'},'expenses'],['title',{title:'Repair'},'expenses'],['recipient',{recipient:'Another shop'},'expenses'],
    ['comment',{comment:''},'expenses'],['null comment',{comment:null},'expenses'],['income source',{source:'Other salary'},'incomes'],
    ['income amount',{amount:15},'incomes'],['income date',{date:new Date(1736942400001)},'incomes'],['income comment',{comment:'Other'},'incomes'],
    ['exact whitespace',{title:' Fuel '},'expenses'],['Unicode normalization',{comment:'e\u0301'},'expenses'],
  ])it('derives stale after '+label+' edit without changing the decision',async()=>{
    await decision({},dataset);await editSource(change,dataset);expectState(await get(a,dataset),'stale','approved');
  });
  it('distinguishes absent, null and empty persisted comments',async()=>{
    h.assertDatabase();await db.collection('expenses').updateOne({_id:oid(operationId),owner:oid(a)},{$unset:{comment:''}});
    await decision();expectState(await get(),'approved');await editSource({comment:null});expectState(await get(),'stale','approved');
    await editSource({comment:''});expectState(await get(),'stale','approved');
  });
  for(const [label,change]of [
    ['unsupported taxonomy',{taxonomyVersion:'financial-classification-v2'}],['unsupported fingerprint',{sourceFingerprintVersion:2}],
    ['malformed assignment',{assignment:{economicRole:'ordinary_expense',layer:'invalid'}}],['invalid revision',{decisionRevision:1.5}],
    ['private unexpected field',{privateField:'Fictional private exception marker'}],['incompatible role',{assignment:{economicRole:'ordinary_income',layer:null}}],
  ])it('blocks '+label+' without unsafe partial metadata',async()=>{
    await decision();h.assertDatabase();await collection().updateOne({owner:oid(a),dataset:'expenses',operationId:oid(operationId)},{$set:change},{bypassDocumentValidation:true});
    expectState(await get(),'blocked',null,null);
  });
  for(const [label,change]of [['invalid amount',{amount:'12.34'}],['unsupported decimal',{amount:()=>h.mongoose.mongo.BSON.Decimal128.fromString('12.34')}],
    ['invalid date',{date:'2025-01-15'}],['missing title',{title:null}]])it('fails closed on source '+label+' even without a classification',async()=>{
    const set=Object.fromEntries(Object.entries(change).map(([k,v])=>[k,typeof v==='function'?v():v]));await editSource(set);
    const res=await get();assert.equal(res.status,503);assert.deepEqual(res.body,{message:'Classification reads unavailable'});
  });
  it('does not conflate the same operation ID across datasets',async()=>{
    await decision();await decision({},'incomes');expectState(await get(),'approved');expectState(await get(a,'incomes'),'approved');
    await editSource({amount:77});expectState(await get(),'stale','approved');expectState(await get(a,'incomes'),'approved');
  });
  it('isolates A/B classifications and uses canonical uppercase identity aliases',async()=>{
    await decision();await decision({state:'explicit_unclassified'},'expenses',b,'222222222222222222222222');
    expectState(await get(),'approved');expectState(await get(b,'expenses','222222222222222222222222'),'explicit_unclassified');
    assert.equal((await get(a,'expenses','222222222222222222222222')).status,404);
    expectState(await get(a.toUpperCase()),'approved');
  });
  it('queries only the JWT owner and complete dataset tuple',async()=>{
    await decision();const original=h.mongoose.mongo.Collection.prototype.findOne,calls=[];
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',function(filter,...args){
      calls.push({name:this.collectionName,filter});return Reflect.apply(original,this,[filter,...args]);
    });
    try{expectState(await rawGet(),'approved');}finally{spy.mock.restore();}
    assert.equal(calls.length,2);
    assert.deepEqual(calls[0],{name:'expenses',filter:{_id:oid(operationId),owner:oid(a)}});
    assert.deepEqual(calls[1],{name:manifest.collectionName,filter:{owner:oid(a),dataset:'expenses',operationId:oid(operationId)}});
  });
  it('does not expose a foreign classification sharing an owned source ID',async()=>{
    const prepared=prepare(input({owner:b}));assert.equal(prepared.ok,true);h.assertDatabase();await collection().insertOne(prepared.value);
    expectState(await get(),'unreviewed',null,null);
  });
  it('GET never invokes DML or DDL, even for missing decisions',async()=>{
    const spies=[];
    for(const method of ['insertOne','insertMany','updateOne','updateMany','replaceOne','deleteOne','deleteMany','bulkWrite','createIndex','createIndexes','dropIndex','drop'])
      spies.push(mock.method(h.mongoose.mongo.Collection.prototype,method,()=>{throw new Error('GET write forbidden');}));
    spies.push(mock.method(db,'createCollection',()=>{throw new Error('GET DDL forbidden');}));
    try{expectState(await get(),'unreviewed',null,null);spies.forEach(x=>assert.equal(x.mock.callCount(),0));}
    finally{spies.reverse().forEach(x=>x.mock.restore());}
  });
  it('accepts exact safe BSON Long revision without rounding',async()=>{
    await decision();h.assertDatabase();await collection().updateOne({owner:oid(a),dataset:'expenses',operationId:oid(operationId)},
      {$set:{decisionRevision:h.mongoose.mongo.BSON.Long.fromString('9007199254740991')}});
    expectState(await get(),'approved','approved',Number.MAX_SAFE_INTEGER);
  });
  it('disabled feature performs no source/classification/metadata queries',async()=>{
    delete process.env.CLASSIFICATION_READ_ENABLED;
    const reads=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',()=>{throw new Error('Read forbidden');});
    const metadata=mock.method(db,'listCollections',()=>{throw new Error('Inspection forbidden');});
    try{const res=await rawGet();assert.equal(res.status,503);assert.equal(reads.mock.callCount(),0);assert.equal(metadata.mock.callCount(),0);}
    finally{reads.mock.restore();metadata.mock.restore();}
  });
  it('missing collection remains unavailable and is never auto-created',async()=>{
    await drop();assert.equal((await get()).status,503);
    assert.equal(await db.listCollections({name:manifest.collectionName}).hasNext(),false);
  });
  for(const [label,alter]of [
    ['validator',async()=>{await db.command({collMod:manifest.collectionName,validator:{}});}],
    ['validation action',async()=>{await db.command({collMod:manifest.collectionName,validationAction:'warn'});}],
    ['validation level',async()=>{await db.command({collMod:manifest.collectionName,validationLevel:'moderate'});}],
    ['missing index',async()=>{await collection().dropIndex(manifest.index.options.name);}],
    ['nonunique index',async()=>{await collection().dropIndex(manifest.index.options.name);await collection().createIndex(manifest.index.key,{name:manifest.index.options.name});}],
    ['sparse index',async()=>{await collection().dropIndex(manifest.index.options.name);await collection().createIndex(manifest.index.key,{...manifest.index.options,sparse:true});}],
    ['partial index',async()=>{await collection().dropIndex(manifest.index.options.name);await collection().createIndex(manifest.index.key,{...manifest.index.options,partialFilterExpression:{state:'approved'}});}],
  ])it('fails closed for incorrect '+label+' with and without records; never repairs it',async()=>{
    await decision();h.assertDatabase();await alter();assert.equal((await get()).status,503);
    h.assertDatabase();await collection().deleteMany({});assert.equal((await get()).status,503);
  });
  it('does not cache readiness after a successful request',async()=>{
    expectState(await get(),'unreviewed',null,null);h.assertDatabase();await collection().dropIndex(manifest.index.options.name);assert.equal((await get()).status,503);
  });
  it('rechecks readiness when collection is dropped between readiness and missing lookup',async()=>{
    const original=h.mongoose.mongo.Collection.prototype.findOne;let dropped=false;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',async function(...args){
      if(this.collectionName===manifest.collectionName&&!dropped){dropped=true;await drop();}
      return Reflect.apply(original,this,args);
    });
    try{assert.equal((await rawGet()).status,503);assert.equal(dropped,true);}finally{spy.mock.restore();}
  });
  for(const stage of ['source','classification','readiness'])it('sanitizes '+stage+' driver failures',async()=>{
    const marker='Fictional private driver detail';let spy;
    if(stage==='readiness')spy=mock.method(db,'listCollections',()=>{throw new Error(marker);});
    else{const original=h.mongoose.mongo.Collection.prototype.findOne;spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',function(...args){
      if(this.collectionName===(stage==='source'?'expenses':manifest.collectionName))throw new Error(marker);
      return Reflect.apply(original,this,args);
    });}
    try{const res=await rawGet();assert.equal(res.status,503);assert.equal(res.text.includes(marker),false);assert.deepEqual(res.body,{message:'Classification reads unavailable'});}
    finally{spy.mock.restore();}
  });
  for(const mutation of ['PATCH','DELETE'])it('demonstrates non-atomic Option A with a controlled concurrent source '+mutation,async()=>{
    await decision();const original=h.mongoose.mongo.Collection.prototype.findOne;let changed=false;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',async function(...args){
      const result=await Reflect.apply(original,this,args);
      if(this.collectionName==='expenses'&&!changed){changed=true;h.assertDatabase();
        if(mutation==='PATCH')await editSource({amount:88});else await db.collection('expenses').deleteOne({_id:oid(operationId),owner:oid(a)});}
      return result;
    });
    try{expectState(await rawGet(),'approved');assert.equal(changed,true);}finally{spy.mock.restore();}
    if(mutation==='PATCH')expectState(await get(),'stale','approved');else assert.equal((await get()).status,404);
  });
  it('documents A-to-B-to-A undetected history without changing the manual assignment',async()=>{
    await decision();await editSource({amount:88});expectState(await get(),'stale','approved');await editSource({amount:12.34});expectState(await get(),'approved');
  });
});
