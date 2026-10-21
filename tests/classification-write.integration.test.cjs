const {describe,it,before,beforeEach,after,mock}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {isDeepStrictEqual}=require('node:util');
const jwt=require('jsonwebtoken');
const {createHarness,testConfiguration}=require('./helpers/mongodb-integration.cjs');
const {syntheticWriteTrust}=require('./helpers/classification-write.cjs');
const {input,omit}=require('./helpers/classification-fixtures.cjs');
const a='aaaaaaaaaaaaaaaaaaaaaaaa',b='bbbbbbbbbbbbbbbbbbbbbbbb';
const op='111111111111111111111111',other='222222222222222222222222',missing='999999999999999999999999';
const requestId=n=>'12345678-1234-4234-8234-'+n.toString(16).padStart(12,'0');
const command=(extra={})=>({kind:'manual_classification',dataset:'expenses',operationId:op,state:'approved',
  assignment:{economicRole:'ordinary_expense',layer:'everyday'},expectedRevision:null,requestId:requestId(1),...extra});
const nonapproved=(state,extra={})=>{const x=command({state,...extra});delete x.assignment;return x;};
const errorCode=(result,code)=>{assert.equal(result.ok,false);assert.equal(result.error.code,code);};

describe('real MongoDB disconnected manual classification write service',{concurrency:false,timeout:120000},()=>{
  let h,db,manifest,prepare,fromBson,sourceFingerprint,createService,trust,contexts,service,initialSourceSnapshot;
  const guard=()=>h.assertDatabase();
  const oid=id=>new h.mongoose.Types.ObjectId(id);
  const records=()=>db.collection(manifest.collectionName);
  const sourceProjection=dataset=>({_id:1,owner:1,amount:1,date:1,comment:1,
    ...(dataset==='expenses'?{category:1,title:1,recipient:1}:{source:1})});
  const snapshot=async(names)=>{guard();return Promise.all(names.map(async name=>
    (await db.collection(name).find({}).sort({_id:1}).toArray()).map(x=>h.mongoose.mongo.BSON.serialize(x))));};
  const sources=()=>snapshot(['expenses','incomes']);
  const classifications=()=>snapshot([manifest.collectionName]);
  const seedSource=(owner,dataset,id)=>({_id:oid(id),owner:oid(owner),amount:12.34,date:new Date(1736942400000),
    ...(dataset==='expenses'?{category:'Транспорт',title:'Fuel',recipient:'Fictional station'}:{source:'Synthetic salary'}),
    comment:'Fictional comment',__v:0,createdAt:new Date(1736942400001),updatedAt:new Date(1736942400002)});
  const observed=async(owner=a,dataset='expenses',id=op)=>{
    guard();const row=await db.collection(dataset).findOne({_id:oid(id),owner:oid(owner)},{projection:sourceProjection(dataset),promoteLongs:false});
    const f=sourceFingerprint(row,{owner,dataset,operationId:id});assert.equal(f.ok,true,'Synthetic review source must validate');
    return {dataset,operationId:id,...f.value};
  };
  const evidence=async(owner=a,dataset='expenses',id=op)=>trust.review(contexts[owner],await observed(owner,dataset,id));
  const invoke=async(c=command(),proof,owner=a,allowSourceChange=false)=>{
    guard();const before=await sources();const result=await service.execute(contexts[owner],c,proof);
    if(!allowSourceChange)assert.equal(isDeepStrictEqual(await sources(),before),true,'Service changed source BSON');
    const output=JSON.stringify(result);
    for(const marker of ['sourceFingerprint','commandFingerprint','lastMutation','Fictional','12.34','stack','password'])
      assert.equal(output.includes(marker),false,'Service outcome contains private data');
    return result;
  };
  const reject=async(c,proof,code,owner=a,allowSourceChange=false)=>{
    const before=await classifications();const result=await invoke(c,proof,owner,allowSourceChange);
    errorCode(result,code);assert.equal(isDeepStrictEqual(await classifications(),before),true,'Rejected command changed classifications');return result;
  };
  const expectSuccess=(result,outcome='created',state='approved',revision=1,sourceStatus='matching_observed')=>{
    assert.equal(result.ok,true,result.ok?'Expected success':result.error.code);assert.deepEqual(result.value,{version:'classification-write-result-v1',outcome,storedState:state,
      decisionRevision:revision,sourceStatus,confirmed:null,consistency:'observed_only_non_atomic'});
  };
  const stored=async(owner=a,dataset='expenses',id=op)=>{
    guard();return records().findOne({owner:oid(owner),dataset,operationId:oid(id)},{promoteLongs:false});
  };
  const edit=async(change,dataset='expenses',id=op)=>{guard();await db.collection(dataset).updateOne({_id:oid(id),owner:oid(a)},{$set:change});};
  const install=async(options=manifest.options,index=manifest.index.options)=>{
    guard();await db.createCollection(manifest.collectionName,options);
    if(index){guard();await records().createIndex(manifest.index.key,index);}
  };
  const drop=async()=>{guard();if(await db.listCollections({name:manifest.collectionName}).hasNext())await records().drop();};
  const seedDecision=async(extra={},owner=a,dataset='expenses',id=op)=>{
    const f=await observed(owner,dataset,id);let candidate=input({owner,dataset,operationId:id,...f,
      assignment:dataset==='expenses'?{economicRole:'ordinary_expense',layer:'everyday'}:{economicRole:'ordinary_income',layer:null},...extra});
    if(candidate.state!=='approved')candidate=omit(candidate,'assignment');const checked=prepare(candidate);assert.equal(checked.ok,true);
    guard();await records().insertOne(checked.value);return checked.value;
  };
  const twoWriters=async(method,commands,proof)=>{
    const original=h.mongoose.mongo.Collection.prototype[method];let arrived=0,release;
    const barrier=new Promise(resolve=>{release=resolve;});const actual=[];
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,method,async function(...args){
      if(this.collectionName!==manifest.collectionName)return Reflect.apply(original,this,args);
      if(++arrived===2)release();await barrier;
      try{const result=await Reflect.apply(original,this,args);actual.push(method==='insertOne'?'inserted':result.matchedCount);return result;}
      catch(e){actual.push(e.code);throw e;}
    });
    try{
      const before=await sources();guard();
      const results=await Promise.all(commands.map(c=>service.execute(contexts[a],c,proof)));
      assert.equal(arrived,2);assert.equal(isDeepStrictEqual(await sources(),before),true,'Concurrent writes changed source BSON');return {results,actual};
    }finally{spy.mock.restore();}
  };
  before(async()=>{
    testConfiguration(process.env);h=await createHarness(process.env);db=h.mongoose.connection.db;
    // The real compiled application imported no write module. Only tests explicitly construct it.
    assert.equal(require.cache[path.resolve(__dirname,'../dist/services/classificationWrite.js')],undefined);
    ({createClassificationWriteService:createService}=require('../dist/services/classificationWrite.js'));
    ({CLASSIFICATION_MANIFEST:manifest}=require('../dist/persistence/classificationManifest.js'));
    ({prepareClassificationDocument:prepare,classificationFromBson:fromBson}=require('../dist/persistence/classification.js'));
    ({sourceFingerprintFromBson:sourceFingerprint}=require('../dist/persistence/classificationSource.js'));
  });
  beforeEach(async()=>{
    guard();trust=syntheticWriteTrust();contexts={[a]:trust.owner(a),[b]:trust.owner(b)};service=createService(h.mongoose.connection,trust.boundary);
    await drop();await install();
    for(const dataset of ['expenses','incomes']){guard();await db.collection(dataset).deleteMany({});
      await db.collection(dataset).insertMany([seedSource(a,dataset,op),seedSource(b,dataset,other)]);}
    initialSourceSnapshot=await sources();
  });
  after(async()=>{
    mock.restoreAll();if(!h)return;
    assert.deepEqual(await h.close(),{dropped:true,disconnected:true,listenerClosed:true,logsClosed:true,directoryRemoved:true,environmentRestored:true});
    console.info('Classification write test-owned MongoDB dropped and verified empty; HTTP/logs/environment released.');
  });
  for(const state of ['approved','explicit_unclassified','cleared'])it('creates initial explicit manual '+state,async()=>{
    const c=state==='approved'?command():nonapproved(state);expectSuccess(await invoke(c,await evidence()),'created',state);
    const raw=await stored();assert.equal(fromBson(raw).ok,true);assert.equal(raw.decisionRevision,1);
    assert.equal(Object.hasOwn(raw,'assignment'),state==='approved');assert.equal(raw.taxonomyVersion,'financial-classification-v1');
    assert.equal(raw.decisionOrigin,'manual');assert.equal(Object.hasOwn(raw,'__v'),false);
  });
  it('creates approved income with explicit null layer',async()=>{
    const c=command({dataset:'incomes',assignment:{economicRole:'ordinary_income',layer:null}});
    expectSuccess(await invoke(c,await evidence(a,'incomes')));assert.equal((await stored(a,'incomes')).assignment.layer,null);
  });
  it('updates layer using CAS and preserves immutable identity/createdAt',async()=>{
    const proof=await evidence();await invoke(command(),proof);const before=await stored();
    expectSuccess(await invoke(command({expectedRevision:1,requestId:requestId(2),assignment:{economicRole:'ordinary_expense',layer:'irregular'}}),proof),'updated','approved',2);
    const after=await stored();for(const key of ['_id','owner','operationId','dataset','createdAt'])assert.equal(isDeepStrictEqual(after[key],before[key]),true);
    assert.equal(after.assignment.layer,'irregular');assert.equal(after.updatedAt.getTime()>=before.updatedAt.getTime(),true);
    assert.equal(after.lastMutation.requestId,requestId(2));assert.equal(after.lastMutation.commandFingerprintVersion,1);
  });
  it('approved -> cleared -> approved keeps revision continuity and removes assignment',async()=>{
    const proof=await evidence();await invoke(command(),proof);
    expectSuccess(await invoke(nonapproved('cleared',{expectedRevision:1,requestId:requestId(2)}),proof),'updated','cleared',2);
    assert.equal(Object.hasOwn(await stored(),'assignment'),false);
    expectSuccess(await invoke(command({expectedRevision:2,requestId:requestId(3)}),proof),'updated','approved',3);
  });
  it('explicit unclassified removes prior assignment atomically',async()=>{
    const proof=await evidence();await invoke(command(),proof);
    expectSuccess(await invoke(nonapproved('explicit_unclassified',{expectedRevision:1,requestId:requestId(2)}),proof),'updated','explicit_unclassified',2);
    assert.equal(Object.hasOwn(await stored(),'assignment'),false);
  });
  it('new same-value manual command still increments exactly once',async()=>{
    const proof=await evidence();await invoke(command(),proof);
    expectSuccess(await invoke(command({expectedRevision:1,requestId:requestId(2)}),proof),'updated','approved',2);
  });
  it('isolates authenticated A/B sources and classifications',async()=>{
    await invoke(command(),await evidence());const aBefore=await stored();
    const cb=command({operationId:other});expectSuccess(await invoke(cb,await evidence(b,'expenses',other),b));
    const fakeBReview=trust.review(contexts[b],{...await observed(),owner:b});
    await reject(command({expectedRevision:1}),fakeBReview,'source_not_found',b);
    assert.equal(isDeepStrictEqual(await stored(),aBefore),true);
  });
  it('supports identical operation IDs in incomes and expenses without conflating CAS',async()=>{
    await invoke(command(),await evidence());
    const c=command({dataset:'incomes',assignment:{economicRole:'ordinary_income',layer:null}});
    expectSuccess(await invoke(c,await evidence(a,'incomes')));assert.equal(await records().countDocuments({}),2);
    expectSuccess(await invoke(command({expectedRevision:1,requestId:requestId(2)}),await evidence()),'updated','approved',2);
    assert.equal((await stored(a,'incomes')).decisionRevision,1);
  });
  it('never discloses a foreign classification sharing the owned operation ID',async()=>{
    // Source _id is unique in its dataset, so two live owners cannot share it.
    // A synthetic orphan tuple for B exercises the independent classification owner key.
    const orphan=prepare(input({owner:b}));assert.equal(orphan.ok,true);guard();await records().insertOne(orphan.value);
    const before=await stored(b);expectSuccess(await invoke(command(),await evidence()));assert.equal(await records().countDocuments({}),2);
    const proofB=trust.review(contexts[b],{...await observed(),owner:b});await reject(command(),proofB,'source_not_found',b);
    assert.equal(isDeepStrictEqual(await stored(b),before),true);
  });
  it('uniformly rejects missing, deleted and foreign-owned sources',async()=>{
    const proof=await evidence(),observation=await observed();
    for(const id of [other,missing]){const bound=trust.review(contexts[a],{...observation,operationId:id});await reject(command({operationId:id}),bound,'source_not_found');}
    guard();await db.collection('expenses').deleteOne({_id:oid(op),owner:oid(a)});await reject(command(),proof,'source_not_found');
  });
  it('has one winner for two actual concurrent initial inserts',async()=>{
    const c2=command({requestId:requestId(2),assignment:{economicRole:'ordinary_expense',layer:'irregular'}});
    const {results,actual}=await twoWriters('insertOne',[command(),c2],await evidence());
    assert.equal(results.filter(x=>x.ok&&x.value.outcome==='created').length,1);assert.equal(results.filter(x=>!x.ok&&x.error.code==='revision_conflict').length,1);
    assert.equal(actual.includes(11000),true,'Expected native unique-index duplicate rejection');assert.equal(await records().countDocuments({}),1);
    assert.equal((await stored()).decisionRevision,1);
  });
  it('has one winner for two actual concurrent conditional CAS updates',async()=>{
    const proof=await evidence();await invoke(command(),proof);
    const c2=command({expectedRevision:1,requestId:requestId(2)}),c3=command({expectedRevision:1,requestId:requestId(3),assignment:{economicRole:'ordinary_expense',layer:'irregular'}});
    const {results,actual}=await twoWriters('updateOne',[c2,c3],proof);
    assert.deepEqual(actual.sort(),[0,1]);assert.equal(results.filter(x=>x.ok&&x.value.outcome==='updated').length,1);
    assert.equal(results.filter(x=>!x.ok&&x.error.code==='revision_conflict').length,1);assert.equal((await stored()).decisionRevision,2);
  });
  for(const phase of ['initial','CAS'])it('reconciles concurrent identical latest '+phase+' requests without another revision',async()=>{
    const proof=await evidence();if(phase==='CAS')await invoke(command(),proof);
    const c=command({expectedRevision:phase==='CAS'?1:null,requestId:requestId(2)});
    const {results}=await twoWriters(phase==='CAS'?'updateOne':'insertOne',[c,c],proof);
    assert.equal(results.every(x=>x.ok),true);assert.equal(results.filter(x=>x.value.outcome==='replayed').length,1);
    assert.equal((await stored()).decisionRevision,phase==='CAS'?2:1);
  });
  for(const state of ['approved','cleared','explicit_unclassified'])it('latest '+state+' replay preserves entire record bytes',async()=>{
    const c=state==='approved'?command():nonapproved(state),proof=await evidence();await invoke(c,proof);
    const before=await classifications();expectSuccess(await invoke(c,proof),'replayed',state);
    assert.equal(isDeepStrictEqual(await classifications(),before),true,'Replay must not update timestamps or revision');
  });
  it('reused latest request ID with different intent conflicts',async()=>{
    const proof=await evidence();await invoke(command(),proof);
    await reject(command({assignment:{economicRole:'ordinary_expense',layer:'irregular'}}),proof,'request_id_conflict');
    await reject(command({expectedRevision:1}),proof,'request_id_conflict');
  });
  it('old command after intervening accepted command conflicts',async()=>{
    const proof=await evidence();await invoke(command(),proof);await invoke(command({expectedRevision:1,requestId:requestId(2)}),proof);
    await reject(command(),proof,'revision_conflict');
  });
  it('does not promise unlimited request-ID history',async()=>{
    const proof=await evidence();await invoke(command(),proof);await invoke(command({expectedRevision:1,requestId:requestId(2)}),proof);
    // Old exact intent conflicts; changed intent at the current revision cannot be recognized as an old ID.
    await reject(command(),proof,'revision_conflict');
    expectSuccess(await invoke(command({expectedRevision:2}),proof),'updated','approved',3);
  });
  for(const phase of ['insert','CAS'])it('reconciles lost '+phase+' acknowledgement by same-command retry',async()=>{
    const proof=await evidence();if(phase==='CAS')await invoke(command(),proof);
    const c=command({expectedRevision:phase==='CAS'?1:null,requestId:requestId(2)}),method=phase==='CAS'?'updateOne':'insertOne';
    const original=h.mongoose.mongo.Collection.prototype[method];let calls=0;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,method,async function(...args){
      const r=await Reflect.apply(original,this,args);if(this.collectionName===manifest.collectionName){calls++;throw new Error('Fictional lost acknowledgement');}return r;
    });
    try{const result=await invoke(c,proof);errorCode(result,'persistence_failure');assert.equal(result.persistence,'unknown');assert.equal(calls,1);}
    finally{spy.mock.restore();}
    expectSuccess(await invoke(c,proof),'replayed','approved',phase==='CAS'?2:1);
  });
  it('rejects wrong expected revisions and missing explicit initial sentinel',async()=>{
    const proof=await evidence();await reject(command({expectedRevision:1}),proof,'revision_conflict');
    await invoke(command(),proof);await reject(command({requestId:requestId(2)}),proof,'revision_conflict');
    await reject(command({expectedRevision:2,requestId:requestId(2)}),proof,'revision_conflict');
  });
  it('rejects revision overflow and preserves MAX_SAFE_INTEGER exactly',async()=>{
    const proof=await evidence();await seedDecision({decisionRevision:Number.MAX_SAFE_INTEGER});
    await reject(command({expectedRevision:Number.MAX_SAFE_INTEGER,requestId:requestId(2)}),proof,'revision_overflow');
  });
  it('increments safe BSON Long revision up to MAX_SAFE_INTEGER without rounding',async()=>{
    const proof=await evidence(),record=await seedDecision({decisionRevision:Number.MAX_SAFE_INTEGER-1});
    guard();await records().updateOne({_id:record._id},{$set:{decisionRevision:h.mongoose.mongo.BSON.Long.fromString('9007199254740990')}});
    expectSuccess(await invoke(command({expectedRevision:Number.MAX_SAFE_INTEGER-1,requestId:requestId(2)}),proof),'updated','approved',Number.MAX_SAFE_INTEGER);
    expectSuccess(await invoke(command({expectedRevision:Number.MAX_SAFE_INTEGER-1,requestId:requestId(2)}),proof),'replayed','approved',Number.MAX_SAFE_INTEGER);
  });
  it('stale review cannot approve source facts computed first during save',async()=>{
    const proof=await evidence();await edit({amount:15});await reject(command(),proof,'stale_review');
    await reject(command(),undefined,'invalid_review');
  });
  for(const change of ['PATCH','DELETE','INVALID'])it('rejects source '+change+' between verification reads',async()=>{
    const proof=await evidence(),original=h.mongoose.mongo.Collection.prototype.findOne;let reads=0;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',async function(...args){
      const row=await Reflect.apply(original,this,args);
      if(this.collectionName==='expenses'&&++reads===1){guard();
        if(change==='PATCH')await edit({amount:88});else if(change==='DELETE')await db.collection('expenses').deleteOne({_id:oid(op),owner:oid(a)});
        else await edit({date:'not a BSON date'});}
      return row;
    });
    try{await reject(command(),proof,change==='PATCH'?'stale_review':change==='DELETE'?'source_not_found':'malformed_source',a,true);assert.equal(reads,2);}
    finally{spy.mock.restore();}
  });
  for(const phase of ['before persistence','after persistence'])it('reports Option A staleness for a source edit '+phase,async()=>{
    const proof=await evidence(),original=h.mongoose.mongo.Collection.prototype.insertOne;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'insertOne',async function(...args){
      if(this.collectionName===manifest.collectionName&&phase==='before persistence')await edit({amount:88});
      const result=await Reflect.apply(original,this,args);
      if(this.collectionName===manifest.collectionName&&phase==='after persistence')await edit({amount:88});return result;
    });
    try{expectSuccess(await invoke(command(),proof,a,true),'created','approved',1,'stale');}finally{spy.mock.restore();}
    assert.equal((await stored()).decisionRevision,1);await reject(command(),proof,'stale_review');
  });
  it('reports a source deleted after commit without undoing or confirming the decision',async()=>{
    const proof=await evidence(),original=h.mongoose.mongo.Collection.prototype.insertOne;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'insertOne',async function(...args){
      const result=await Reflect.apply(original,this,args);if(this.collectionName===manifest.collectionName){guard();await db.collection('expenses').deleteOne({_id:oid(op),owner:oid(a)});}return result;
    });
    try{expectSuccess(await invoke(command(),proof,a,true),'created','approved',1,'missing');}finally{spy.mock.restore();}
    await reject(command(),proof,'source_not_found');
  });
  it('matching post-read is still only an observation, not an atomic freshness promise',async()=>{
    const proof=await evidence(),original=h.mongoose.mongo.Collection.prototype.findOne;let reads=0;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',async function(...args){
      const row=await Reflect.apply(original,this,args);if(this.collectionName==='expenses'&&++reads===3)await edit({amount:88});return row;
    });
    try{expectSuccess(await invoke(command(),proof,a,true));assert.equal(reads,3);}finally{spy.mock.restore();}
    await reject(command(),proof,'stale_review');
  });
  it('cannot detect A -> B -> A edit history',async()=>{
    const proof=await evidence();await edit({amount:88});await edit({amount:12.34});expectSuccess(await invoke(command(),proof));
  });
  it('explicit new review may replace a stale decision through CAS; old proof cannot',async()=>{
    const proof=await evidence();await invoke(command(),proof);await edit({amount:88});
    const c=command({expectedRevision:1,requestId:requestId(2)});await reject(c,proof,'stale_review');
    expectSuccess(await invoke(c,await evidence()),'updated','approved',2);
  });
  for(const [label,value]of [['string','12.34'],['NaN',NaN],['decimal',()=>h.mongoose.mongo.BSON.Decimal128.fromString('12.34')],
    ['safe Long',()=>h.mongoose.mongo.BSON.Long.fromNumber(12)],['unsafe Long',()=>h.mongoose.mongo.BSON.Long.fromString('9007199254740993')]])
    it('rejects malformed/unsupported source amount '+label,async()=>{
      const proof=await evidence();await edit({amount:typeof value==='function'?value():value});await reject(command(),proof,'malformed_source');
    });
  for(const [label,change]of [['date',{date:'2025-01-15'}],['required string',{title:null}],['comment',{comment:{private:'fictional'}}]])
    it('rejects malformed source '+label,async()=>{const proof=await evidence();await edit(change);await reject(command(),proof,'malformed_source');});
  for(const [label,change,code]of [
    ['taxonomy',{taxonomyVersion:'financial-classification-v2'},'unsupported_taxonomy'],
    ['provisional taxonomy',{taxonomyVersion:'financial-layers-v1-provisional'},'unsupported_taxonomy'],
    ['fingerprint version',{sourceFingerprintVersion:2},'unsupported_fingerprint_version'],
    ['assignment',{assignment:{economicRole:'ordinary_expense',layer:'invalid'}},'blocked_decision'],
    ['revision',{decisionRevision:1.5},'blocked_decision'],['metadata',{lastMutation:{}},'blocked_decision'],
  ])it('blocks malformed/unsupported stored '+label+' without repairing it',async()=>{
    const proof=await evidence();await seedDecision();guard();await records().updateOne({owner:oid(a),dataset:'expenses',operationId:oid(op)},{$set:change},{bypassDocumentValidation:true});
    await reject(command({expectedRevision:1,requestId:requestId(2)}),proof,code);
  });
  it('does not accept forged lastMutation as a verified replay of a different state',async()=>{
    const proof=await evidence();await invoke(command(),proof);guard();
    await records().updateOne({owner:oid(a),dataset:'expenses',operationId:oid(op)},{$set:{state:'cleared'},$unset:{assignment:''}});
    await reject(command(),proof,'blocked_decision');
  });
  for(const [label,change]of [
    ['invalid stable role',{assignment:{economicRole:'ordinary_income',layer:null}}],['invalid layer',{assignment:{economicRole:'ordinary_expense',layer:'unknown'}}],
    ['client taxonomy',{taxonomyVersion:'financial-classification-v1'}],['client metadata',{lastMutation:{requestId:requestId(1)}}],
    ['invalid UUID',{requestId:'not-a-uuid'}],['client owner',{owner:b}],
  ])it('rejects '+label+' before any persistence',async()=>await reject(command(change),await evidence(),'invalid_command'));
  it('rejects mismatched/missing/raw/unsupported review evidence',async()=>{
    const observation=await observed();
    await reject(command(),undefined,'invalid_review');await reject(command(),{...observation,owner:a,kind:'verified_manual_review'},'invalid_review');
    for(const change of [{owner:b},{dataset:'incomes'},{operationId:other}])
      await reject(command(),trust.review(contexts[a],{...observation,...change}),'review_mismatch');
    await reject(command(),trust.review(contexts[a],{...observation,sourceFingerprintVersion:2}),'unsupported_fingerprint_version');
  });
  it('no recurrence or AI suggestion persists without verified explicit manual intent',async()=>{
    const proof=await evidence();for(const c of [{version:'observations-v0',observations:[]},{kind:'ai_suggestion',assignment:command().assignment},
      {...command(),kind:'automatic_classification'}])await reject(c,proof,'invalid_command');
  });
  it('missing collection stays missing; there is no automatic installation',async()=>{
    const proof=await evidence();await drop();await reject(command(),proof,'infrastructure_unavailable');
    assert.equal(await db.listCollections({name:manifest.collectionName}).hasNext(),false);
  });
  for(const [label,alter]of [
    ['validator',async()=>{await db.command({collMod:manifest.collectionName,validator:{}});}],
    ['warn validation',async()=>{await db.command({collMod:manifest.collectionName,validationAction:'warn'});}],
    ['moderate validation',async()=>{await db.command({collMod:manifest.collectionName,validationLevel:'moderate'});}],
    ['missing index',async()=>{await records().dropIndex(manifest.index.options.name);}],
    ['nonunique index',async()=>{await records().dropIndex(manifest.index.options.name);await records().createIndex(manifest.index.key,{name:manifest.index.options.name});}],
    ['sparse index',async()=>{await records().dropIndex(manifest.index.options.name);await records().createIndex(manifest.index.key,{...manifest.index.options,sparse:true});}],
  ])it('refuses mismatched '+label+' without repair',async()=>{
    const proof=await evidence();guard();await alter();await reject(command(),proof,'infrastructure_unavailable');
  });
  it('rechecks readiness immediately before final source verification',async()=>{
    const proof=await evidence(),original=h.mongoose.mongo.Collection.prototype.findOne;let altered=false;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',async function(...args){
      const result=await Reflect.apply(original,this,args);if(this.collectionName===manifest.collectionName&&!altered){altered=true;guard();await records().dropIndex(manifest.index.options.name);}return result;
    });
    try{await reject(command(),proof,'infrastructure_unavailable');assert.equal(altered,true);}finally{spy.mock.restore();}
  });
  it('does not recreate a collection dropped before the final readiness check',async()=>{
    const proof=await evidence(),original=h.mongoose.mongo.Collection.prototype.findOne;let dropped=false;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',async function(...args){
      const row=await Reflect.apply(original,this,args);
      if(this.collectionName===manifest.collectionName&&!dropped){dropped=true;await drop();}return row;
    });
    try{await reject(command(),proof,'infrastructure_unavailable');assert.equal(dropped,true);}
    finally{spy.mock.restore();}
    assert.equal(await db.listCollections({name:manifest.collectionName}).hasNext(),false);
  });
  it('does not treat duplicate errors from an unrelated index as idempotent success',async()=>{
    const proof=await evidence();await invoke(command(),proof);guard();await records().createIndex({state:1},{unique:true});
    guard();await db.collection('expenses').insertOne(seedSource(a,'expenses',missing));
    const result=await reject(command({operationId:missing,requestId:requestId(2)}),await evidence(a,'expenses',missing),'persistence_failure');
    assert.equal(result.persistence,'unknown');assert.equal(await records().countDocuments({}),1);
  });
  it('uses one native owner-scoped CAS with no upsert, transaction or source writes',async()=>{
    const proof=await evidence();await invoke(command(),proof);const original=h.mongoose.mongo.Collection.prototype.updateOne,calls=[];
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'updateOne',function(...args){calls.push({name:this.collectionName,args});return Reflect.apply(original,this,args);});
    const session=mock.method(h.mongoose.connection,'startSession',()=>{throw new Error('Transactions forbidden');});
    try{expectSuccess(await invoke(nonapproved('cleared',{expectedRevision:1,requestId:requestId(2)}),proof),'updated','cleared',2);
      assert.equal(session.mock.callCount(),0);assert.equal(calls.length,1);const [filter,update,options]=calls[0].args;
      assert.equal(calls[0].name,manifest.collectionName);assert.equal(filter.owner.equals(oid(a)),true);assert.equal(filter.operationId.equals(oid(op)),true);
      assert.equal(filter.dataset,'expenses');assert.equal(filter.decisionRevision,1);assert.equal(options.upsert,false);
      assert.equal(update.$set.decisionRevision,2);assert.deepEqual(update.$unset,{assignment:''});assert.equal(Object.hasOwn(update.$set,'createdAt'),false);
    }finally{spy.mock.restore();session.mock.restore();}
  });
  for(const stage of ['source','decision','readiness'])it('sanitizes '+stage+' read failures without private exceptions',async()=>{
    const proof=await evidence();let spy;
    if(stage==='readiness')spy=mock.method(db,'listCollections',()=>{throw new Error('Fictional private password');});
    else{const original=h.mongoose.mongo.Collection.prototype.findOne;spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',function(...args){
      if(this.collectionName===(stage==='source'?'expenses':manifest.collectionName))throw new Error('Fictional private password');return Reflect.apply(original,this,args);});}
    try{await reject(command(),proof,stage==='source'?'source_unavailable':stage==='readiness'?'infrastructure_unavailable':'persistence_failure');}
    finally{spy.mock.restore();}
  });
  it('acknowledges committed write but marks unavailable post-write source safely',async()=>{
    const proof=await evidence(),original=h.mongoose.mongo.Collection.prototype.findOne;let count=0;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',function(...args){
      if(this.collectionName==='expenses'&&++count===3)throw new Error('Fictional private password');return Reflect.apply(original,this,args);
    });
    try{expectSuccess(await invoke(command(),proof),'created','approved',1,'unavailable');}finally{spy.mock.restore();}
  });
  it('acknowledges a commit with invalid post-write source without any confirmed assignment',async()=>{
    const proof=await evidence(),original=h.mongoose.mongo.Collection.prototype.insertOne;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'insertOne',async function(...args){
      const result=await Reflect.apply(original,this,args);if(this.collectionName===manifest.collectionName)await edit({amount:'invalid'});return result;
    });
    try{expectSuccess(await invoke(command(),proof,a,true),'created','approved',1,'invalid');}finally{spy.mock.restore();}
    await reject(command(),proof,'malformed_source');
  });
  it('does not use timestamp equality as CAS and never moves updatedAt backwards',async()=>{
    const proof=await evidence(),future=new Date(4102444800000),raw=await seedDecision({updatedAt:future});
    expectSuccess(await invoke(command({expectedRevision:1,requestId:requestId(2)}),proof),'updated','approved',2);
    const after=await stored();assert.equal(after.updatedAt.getTime(),future.getTime());assert.equal(after.createdAt.getTime(),raw.createdAt.getTime());
  });
  it('keeps public classification writes unreachable and all source BSON unchanged',async()=>{
    const before=await classifications();for(const method of ['POST','PATCH','DELETE']){
      const res=await h.request(method,'/classifications/expenses/'+op,method==='DELETE'?undefined:command(),jwt.sign({_id:a,exp:4102444800},'super-secret-key'));
      assert.equal(res.status,404);
    }
    assert.equal(isDeepStrictEqual(await classifications(),before),true);assert.equal(isDeepStrictEqual(await sources(),initialSourceSnapshot),true);
  });
});
