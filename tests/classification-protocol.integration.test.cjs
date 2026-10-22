const {describe,it,before,beforeEach,after,mock}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes,randomUUID}=require('node:crypto');
const jwt=require('jsonwebtoken');
const {createHarness,testConfiguration}=require('./helpers/mongodb-integration.cjs');
const id='1'.repeat(24),b='b'.repeat(24);
const gates=['CLASSIFICATION_REVIEW_ENABLED','CLASSIFICATION_WRITE_ENABLED','CLASSIFICATION_RECONCILE_ENABLED'];
describe('P6 approved HTTP protocol with real disposable MongoDB',{concurrency:false,timeout:120000},()=>{
  let h,db,manifest,install,remove,a,sequence=0,saved,clock,issuedAt,operational,quota,ring,config;
  const oid=x=>new h.mongoose.Types.ObjectId(x);
  const token=(owner=a,extra={})=>jwt.sign({_id:owner,iat:issuedAt,exp:4102444800,...extra},'super-secret-key');
  const body=(extra={})=>({version:'classification-review-request-v1',browserReviewContext:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    requestId:randomUUID(),expectedRevision:null,state:'approved',assignment:{economicRole:'ordinary_expense',layer:'everyday'},...extra});
  const call=async(action,payload,credential=token(),operationId=id,options)=>{
    const r=await h.request('POST','/classifications/expenses/'+operationId+'/'+action,payload,credential,options);
    if(r.status>=400 && !(r.status===401 && typeof r.body.message==='string')){
      assert.equal(r.body.version,'classification-http-error-v1');
      assert.equal(['not_applied','unknown'].includes(r.body.persistence),true);
      assert.deepEqual(Object.keys(r.body).sort(),['error','persistence','version']);
      assert.deepEqual(Object.keys(r.body.error),['code']);
      assert.equal(['invalid_request','reauth_required','invalid_review','forbidden_origin','operation_not_found','stale_review',
        'revision_conflict','request_id_conflict','revision_overflow','blocked_decision','review_expired','reconciliation_window_expired',
        'review_too_large','request_too_large','unsupported_media_type','unavailable','internal_failure','persistence_unknown'].includes(r.body.error.code),true);
    }
    return r;
  };
  const prepare=async(extra={},credential=token())=>{
    const command=body(extra),res=await call('reviews',command,credential);assert.equal(res.status,200,'Synthetic review preparation must succeed');
    return {command,proof:res.body.reviewProof,response:res.body};
  };
  const apply=(p,extra={},credential=token())=>call('commands',{...p.command,version:'classification-command-v1',reviewProof:p.proof,...extra},credential);
  const reconcile=(p,extra={},credential=token())=>call('commands/reconcile',{...p.command,version:'classification-reconcile-request-v1',reviewProof:p.proof,...extra},credential);
  const count=()=>db.collection(manifest.collectionName).countDocuments({});
  const sources=async()=>{h.assertDatabase();return Promise.all(['expenses','incomes'].map(async name=>
    (await db.collection(name).find({}).sort({_id:1}).toArray()).map(x=>h.mongoose.mongo.BSON.serialize(x).toString('hex'))));};
  const change=async(fields)=>{h.assertDatabase();await db.collection('expenses').updateOne({_id:oid(id),owner:oid(a)},{$set:fields});};
  const configure=()=>{remove?.();remove=install(require('../dist/app'),h.mongoose.connection,config);};
  before(async()=>{
    testConfiguration(process.env);saved=Object.fromEntries(gates.map(g=>[g,process.env[g]]));h=await createHarness(process.env);db=h.mongoose.connection.db;
    ({CLASSIFICATION_MANIFEST:manifest}=require('../dist/persistence/classificationManifest'));
    ({installClassificationProtocol:install}=require('../dist/services/classificationProtocol'));
  });
  beforeEach(async()=>{
    a=(++sequence+1000).toString(16).padStart(24,'0');clock=Math.floor(Date.now()/1000);issuedAt=clock;operational=true;quota=100;
    ring={activeKid:'synthetic',keys:[{kid:'synthetic',state:'active',key:randomBytes(32)}]};
    config={keyring:ring,deploymentId:'isolated-test-era',operations:{ready:()=>operational,reserveIssuance:()=>quota-->0,nowSeconds:()=>clock}};
    configure();for(const gate of gates)process.env[gate]='1';h.assertDatabase();
    for(const name of ['expenses','incomes','users'])await db.collection(name).deleteMany({});
    await db.collection('users').insertMany([{_id:oid(a)},{_id:oid(b)}]);
    await db.collection('expenses').insertOne({_id:oid(id),owner:oid(a),amount:12.34,date:new Date(1736942400001),category:'Транспорт',title:'Fuel',recipient:'Fictional',comment:''});
    if(await db.listCollections({name:manifest.collectionName}).hasNext())await db.collection(manifest.collectionName).drop();
    await db.createCollection(manifest.collectionName,manifest.options);await db.collection(manifest.collectionName).createIndex(manifest.index.key,manifest.index.options);
  });
  after(async()=>{
    remove?.();mock.restoreAll();for(const gate of gates){if(saved?.[gate]===undefined)delete process.env[gate];else process.env[gate]=saved[gate];}
    if(h){assert.deepEqual(await h.close(),{dropped:true,disconnected:true,listenerClosed:true,logsClosed:true,directoryRemoved:true,environmentRestored:true});
      console.info('Classification protocol test-owned MongoDB dropped and verified empty; HTTP/logs/environment released.');}
  });
  it('HTTP01 authenticates real JWT and existing account before authorized preparation',async()=>{
    assert.equal((await call('reviews',body(),'')).status,401);assert.equal((await call('reviews',body(),'invalid')).status,401);
    const p=await prepare();assert.equal(p.response.currentDecision.decisionRevision,null);assert.equal(p.response.facts.amount.value,'12.34');
    assert.equal(p.response.facts.dateEpochMs,1736942400001);assert.equal(p.response.expiresAt,clock+300);assert.equal(await count(),0);
  });
  it('HTTP02 isolates foreign/missing/deleted operations uniformly',async()=>{
    const foreign=await call('reviews',body(),token(b)),missing=await call('reviews',body(),token(),'9'.repeat(24));
    await db.collection('expenses').deleteOne({_id:oid(id)});const deleted=await call('reviews',body());
    for(const r of [foreign,missing,deleted]){assert.equal(r.status,404);assert.deepEqual(r.body,{version:'classification-http-error-v1',error:{code:'operation_not_found'},persistence:'not_applied'});}
  });
  it('HTTP03 rejects forged owner/digest/taxonomy/confirmation and unknown properties',async()=>{
    for(const extra of [{owner:b},{sourceFingerprint:'a'.repeat(64)},{taxonomyVersion:'financial-classification-v1'},{confirmed:true},{extra:1}])
      assert.equal((await call('reviews',body(extra))).status,400);
  });
  it('HTTP04 rejects unsupported assignment policy without persistence',async()=>{
    for(const assignment of [{economicRole:'ordinary_income',layer:null},{economicRole:'unknown',layer:null},{economicRole:'ordinary_expense',layer:'unknown'}])
      assert.equal((await call('reviews',body({assignment}))).status,400);
    assert.equal(await count(),0);
  });
  it('HTTP05 captures exact owned facts, binary64, Unicode and comment distinctions',async()=>{
    for(const comment of [null,'','é','e\u0301']){
      await change({comment,amount:new h.mongoose.mongo.BSON.Double(-0)});const p=await prepare();assert.equal(p.response.facts.amount.value,'-0');
      assert.equal(p.response.facts.comment.kind,comment===null?'null':'value');if(comment!==null)assert.equal(p.response.facts.comment.value===comment,true);
    }
  });
  it('HTTP06 preserves invalid/unsupported source facts as unavailable, not rounded',async()=>{
    await change({amount:'12.34'});assert.equal((await call('reviews',body())).status,503);assert.equal(await count(),0);
  });
  it('HTTP07 creates an approved decision only after separate apply and authoritative acknowledgement',async()=>{
    const before=await sources(),p=await prepare();assert.equal(await count(),0);const r=await apply(p);
    assert.equal(r.status,201);assert.equal(r.body.outcome,'created');assert.equal(r.body.confirmed,null);assert.equal(r.body.decisionRevision,1);
    assert.deepEqual(await sources(),before);assert.equal(await count(),1);
  });
  it('HTTP08 binds every mutable command field and browser context',async()=>{
    const p=await prepare();
    for(const edit of [{requestId:randomUUID()},{expectedRevision:1},{state:'explicit_unclassified',assignment:undefined},
      {assignment:{economicRole:'ordinary_expense',layer:'irregular'}},{browserReviewContext:randomUUID()}])assert.equal((await apply(p,edit)).status,403);
    assert.equal(await count(),0);
  });
  it('HTTP09 binds exact verified bearer even for the same actor',async()=>{
    const p=await prepare();assert.equal((await apply(p,{},token(a,{jti:'other-fictional-session'}))).status,403);assert.equal(await count(),0);
  });
  it('HTTP10 cross-owner proof cannot authorize a write',async()=>{
    const p=await prepare();assert.equal((await apply(p,{},token(b))).status,403);assert.equal(await count(),0);
  });
  it('HTTP11 tampered ciphertext/tag/nonce never reaches persistence',async()=>{
    const p=await prepare();for(const segment of [2,3,4]){const parts=p.proof.split('.');const bytes=Buffer.from(parts[segment],'base64url');bytes[0]^=1;
      parts[segment]=bytes.toString('base64url');assert.equal((await apply({...p,proof:parts.join('.')})).status,403);}assert.equal(await count(),0);
  });
  it('HTTP12 expired proof is refused for apply without grace',async()=>{
    const p=await prepare();clock+=300;const r=await apply(p);assert.equal(r.status,410);assert.equal(r.body.persistence,'not_applied');assert.equal(await count(),0);
  });
  it('HTTP13 expired/missing JWT exp cannot prepare or apply',async()=>{
    const p=await prepare();for(const t of [token(a,{exp:1}),jwt.sign({_id:a},'super-secret-key')]){
      assert.equal((await call('reviews',body(),t)).status,401);assert.equal((await apply(p,{},t)).status,401);
    }
  });
  it('HTTP14 source edits after review reject without touching classifications',async()=>{
    const p=await prepare();await change({amount:99});const r=await apply(p);assert.equal(r.status,409);assert.equal(r.body.error.code,'stale_review');assert.equal(await count(),0);
  });
  it('HTTP15 source deletion is a safe 404 and does not insert an orphan',async()=>{
    const p=await prepare();await db.collection('expenses').deleteOne({_id:oid(id)});assert.equal((await apply(p)).status,404);assert.equal(await count(),0);
  });
  it('HTTP16 observed A→B→A is an accepted undetected-history limitation',async()=>{
    const p=await prepare();await change({amount:99});await change({amount:12.34});assert.equal((await apply(p)).status,201);
  });
  it('HTTP17 same command retry is replayed without a new revision',async()=>{
    const p=await prepare();assert.equal((await apply(p)).status,201);const r=await apply(p);assert.equal(r.status,200);assert.equal(r.body.outcome,'replayed');assert.equal(r.body.decisionRevision,1);
  });
  it('HTTP18 concurrent double submission produces one CAS insert and replay',async()=>{
    const p=await prepare(),r=await Promise.all([apply(p),apply(p)]);assert.equal(r.every(x=>[200,201].includes(x.status)),true);
    assert.equal(await count(),1);assert.equal(r.every(x=>x.body.decisionRevision===1),true);
  });
  it('HTTP19 concurrent distinct decisions conflict instead of silent rebase',async()=>{
    const p=await prepare(),q=await prepare({assignment:{economicRole:'ordinary_expense',layer:'irregular'}});
    assert.equal((await apply(p)).status,201);assert.equal((await apply(q)).status,409);assert.equal(await count(),1);
  });
  it('HTTP20 edits previously approved decisions using exact expected revision',async()=>{
    const p=await prepare();await apply(p);const q=await prepare({expectedRevision:1,assignment:{economicRole:'ordinary_expense',layer:'irregular'}});
    assert.equal(q.response.currentDecision.storedState,'approved');const r=await apply(q);assert.equal(r.status,200);assert.equal(r.body.decisionRevision,2);
  });
  it('HTTP21 explicit-unclassified and cleared states persist without assignments',async()=>{
    for(const [state,expectedRevision] of [['explicit_unclassified',null],['cleared',1]]){
      const p=await prepare({state,expectedRevision,assignment:undefined});const r=await apply(p);assert.equal([200,201].includes(r.status),true);
      assert.equal(r.body.storedState,state);const row=await db.collection(manifest.collectionName).findOne({owner:oid(a)});assert.equal(Object.hasOwn(row,'assignment'),false);
    }
  });
  it('HTTP22 same latest request ID with different sealed intent is conflict',async()=>{
    const p=await prepare();const q=await prepare({requestId:p.command.requestId,assignment:{economicRole:'ordinary_expense',layer:'irregular'}});
    await apply(p);assert.equal((await apply(q)).status,409);assert.equal((await reconcile(q)).status,409);
  });
  it('HTTP23 lost acknowledgement after real commit reconciles without retrying a write',async()=>{
    const p=await prepare(),original=h.mongoose.mongo.Collection.prototype.insertOne;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'insertOne',async function(...args){const r=await Reflect.apply(original,this,args);
      if(this.collectionName===manifest.collectionName)throw Error('Synthetic acknowledgement loss');return r;});
    try{const r=await apply(p);assert.equal(r.status,503);assert.equal(r.body.persistence,'unknown');}finally{spy.mock.restore();}
    assert.equal(await count(),1);const r=await reconcile(p);assert.equal(r.status,200);assert.equal(r.body.result,'latest_applied');
  });
  it('HTTP24 expired proof can only reconcile within the bounded recovery window',async()=>{
    const p=await prepare();await apply(p);clock+=300;assert.equal((await apply(p)).status,410);
    assert.equal((await reconcile(p)).body.result,'latest_applied');clock+=86400;assert.equal((await reconcile(p)).status,410);
  });
  it('HTTP25 reconcile of an unexecuted proof stays indeterminate and never inserts',async()=>{
    const p=await prepare();clock+=301;const r=await reconcile(p);assert.equal(r.status,200);assert.equal(r.body.result,'indeterminate');assert.equal(r.body.receipt,null);assert.equal(await count(),0);
  });
  it('HTTP26 latest overwritten decision does not fabricate an old receipt',async()=>{
    const p=await prepare();await apply(p);const q=await prepare({expectedRevision:1});await apply(q);
    assert.equal((await reconcile(p)).body.result,'indeterminate');
  });
  it('HTTP27 readonly recovery enforces same bearer/account/context after expiry',async()=>{
    const p=await prepare();await apply(p);clock+=301;
    assert.equal((await reconcile(p,{},token(a,{jti:'different'}))).status,403);
    assert.equal((await reconcile(p,{browserReviewContext:randomUUID()})).status,403);
    await db.collection('users').deleteOne({_id:oid(a)});assert.equal((await reconcile(p)).status,401);
  });
  it('HTTP28 recovery reports changed source and hides orphan receipts after deletion',async()=>{
    const p=await prepare();await apply(p);await change({amount:88});assert.equal((await reconcile(p)).body.receipt.sourceStatus,'stale');
    await db.collection('expenses').deleteOne({_id:oid(id)});const r=await reconcile(p);assert.equal(r.status,404);assert.equal(Object.hasOwn(r.body,'receipt'),false);
  });
  it('HTTP29 explicitly documents post-observation PATCH as non-atomic',async()=>{
    const p=await prepare();let changed=false;const original=h.mongoose.mongo.Collection.prototype.insertOne;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'insertOne',async function(...args){if(this.collectionName===manifest.collectionName&&!changed){changed=true;await change({amount:88});}
      return Reflect.apply(original,this,args);});
    try{const r=await apply(p);assert.equal(r.status,201);assert.equal(r.body.sourceStatus,'stale');assert.equal(r.body.confirmed,null);}finally{spy.mock.restore();}
  });
  it('HTTP30 independent default-off gates and missing operational adapter fail closed',async()=>{
    const p=await prepare();for(const [action,payload,gate] of [['reviews',body(),gates[0]],['commands',{...p.command,version:'classification-command-v1',reviewProof:p.proof},gates[1]],
      ['commands/reconcile',{...p.command,version:'classification-reconcile-request-v1',reviewProof:p.proof},gates[2]]]){
      delete process.env[gate];assert.equal((await call(action,payload)).status,503);process.env[gate]='1';}
    remove();assert.equal((await call('reviews',body())).status,503);assert.equal(await count(),0);
  });
  it('HTTP31 account deletion between prepare and apply invalidates admission',async()=>{
    const p=await prepare();await db.collection('users').deleteOne({_id:oid(a)});assert.equal((await apply(p)).status,401);assert.equal(await count(),0);
  });
  it('HTTP32 Origin/JSON/raw duplicate/size controls apply to the entire protocol',async()=>{
    for(const [options,status] of [[{headers:{Origin:'https://foreign.invalid'}},403],[{headers:{Origin:'null'}},403],
      [{headers:{'Content-Type':'application/x-www-form-urlencoded'}},415],[{rawBody:'{"state":1,"state":2}'},400],[{rawBody:'{"x":"'+'x'.repeat(8200)+'"}'},413]])
      assert.equal((await call('reviews',body(),token(),id,options)).status,status);
  });
  it('HTTP33 excludes private digests, credential binding, BSON and raw errors from DTOs',async()=>{
    const p=await prepare();for(const key of ['sourceFingerprint','credentialBinding','lastMutation','_id','owner','stack'])
      assert.equal(JSON.stringify(p.response).includes('"'+key+'"'),false,'Private DTO metadata excluded');
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',()=>{throw Error('Fictional private failure');});
    try{const r=await call('reviews',body());assert.equal(r.status,503);assert.deepEqual(r.body,{version:'classification-http-error-v1',error:{code:'internal_failure'},persistence:'not_applied'});}finally{spy.mock.restore();}
  });
  it('HTTP34 no-store, no ETag and Vary on success/auth/failure',async()=>{
    for(const t of [token(),'']){const r=await call('reviews',body(),t);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers.etag,undefined);
      assert.equal(r.headers.vary.includes('Authorization'),true);assert.equal(r.headers.vary.includes('Origin'),true);}
  });
  it('HTTP35 a lost client lifecycle is not a server rollback guarantee',async()=>{
    const p=await prepare();await apply(p);const q=await reconcile(p,{browserReviewContext:randomUUID()});assert.equal(q.status,403);assert.equal(await count(),1);
  });
  it('HTTP36 apply cannot mint review evidence from current source',async()=>{
    const p=await prepare();await change({title:'Repair'});quota=0;assert.equal((await apply(p)).status,409);assert.equal(await count(),0);
    assert.equal((await call('commands',{...body(),version:'classification-command-v1',reviewProof:'invalid'})).status,403);
  });
  it('HTTP37 suggestions/automatic origins cannot bypass strict manual DTOs',async()=>{
    for(const extra of [{decisionOrigin:'automatic'},{kind:'suggestion'},{taxonomyVersion:'financial-layers-v1-provisional'},{reviewed:true}])
      assert.equal((await call('reviews',body(extra))).status,400);assert.equal(await count(),0);
  });
  it('HTTP38 reconciliation has zero source/classification DML or DDL on every branch',async()=>{
    const p=await prepare();assert.equal((await apply(p)).status,201);const before=await sources(),spies=[];
    for(const method of ['insertOne','updateOne','replaceOne','deleteOne','deleteMany','bulkWrite','createIndex','drop'])
      spies.push(mock.method(h.mongoose.mongo.Collection.prototype,method,()=>{throw Error('Recovery write forbidden');}));
    try{const first=await reconcile(p);for(const spy of spies)assert.equal(spy.mock.callCount(),0,'Reconcile must not invoke mutation methods');
      assert.equal(first.status,200);assert.equal(first.body.result,'latest_applied');clock+=301;const second=await reconcile(p);
      assert.equal(second.status,200);assert.equal(second.body.result,'latest_applied');
      for(const spy of spies)assert.equal(spy.mock.callCount(),0);}finally{spies.forEach(s=>s.mock.restore());}
    assert.deepEqual(await sources(),before);
  });
  it('HTTP39 guarded cleanup is mandatory; readiness loss never installs/repairs',async()=>{
    const p=await prepare();await db.collection(manifest.collectionName).dropIndex(manifest.index.options.name);
    assert.equal((await apply(p)).status,503);assert.equal((await reconcile(p)).status,503);
    assert.equal((await db.collection(manifest.collectionName).listIndexes().toArray()).some(x=>x.name===manifest.index.options.name),false);
  });
  it('multi-instance shared key/era verification and revocation gates',async()=>{
    const p=await prepare();configure();assert.equal((await apply(p)).status,201);
    operational=false;assert.equal((await reconcile(p)).status,503);assert.equal((await call('reviews',body())).status,503);
    operational=true;config={...config,deploymentId:'different-era'};configure();assert.equal((await reconcile(p)).status,403);
  });
  it('fleet issuance reservation exhaustion and invalid keyring fail closed',async()=>{
    quota=0;assert.equal((await call('reviews',body())).status,503);assert.equal(await count(),0);
    assert.throws(()=>install(require('../dist/app'),h.mongoose.connection,{...config,keyring:{}}),/configuration unavailable/);
  });
  it('persists an income manual decision through the same HTTP protocol',async()=>{
    await db.collection('incomes').insertOne({_id:oid(id),owner:oid(a),amount:45.67,date:new Date(1736942400001),source:'Fictional salary'});
    const command=body({assignment:{economicRole:'ordinary_income',layer:null}});
    const r=await h.request('POST','/classifications/incomes/'+id+'/reviews',command,token());assert.equal(r.status,200);
    assert.equal(Object.hasOwn(r.body.facts,'category'),false);assert.equal(r.body.facts.source,'Fictional salary');
    const ack=await h.request('POST','/classifications/incomes/'+id+'/commands',{...command,version:'classification-command-v1',reviewProof:r.body.reviewProof},token());
    assert.equal(ack.status,201);assert.equal(ack.body.confirmed,null);
  });
  it('rejects operation/dataset proof substitution and accepts canonical path aliases',async()=>{
    const p=await prepare();const payload={...p.command,version:'classification-command-v1',reviewProof:p.proof};
    assert.equal((await call('commands',payload,token(),'2'.repeat(24))).status,403);
    assert.equal((await h.request('POST','/classifications/incomes/'+id+'/commands',payload,token())).status,400);
    assert.equal((await call('commands',payload,token(),id.toUpperCase())).status,201);
  });
  it('prepare uses one owned source object for display and sealed observation under concurrent PATCH',async()=>{
    const original=h.mongoose.mongo.Collection.prototype.findOne;let changed=false;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'findOne',async function(...args){const row=await Reflect.apply(original,this,args);
      if(this.collectionName==='expenses'&&!changed){changed=true;await change({amount:77});}return row;});
    let p;try{p=await prepare();assert.equal(p.response.facts.amount.value,'12.34');}finally{spy.mock.restore();}
    assert.equal((await apply(p)).status,409);assert.equal(await count(),0);
  });
  it('oversize/unsupported presentation never returns proof or truncates facts',async()=>{
    await change({comment:'x'.repeat(8193)});const r=await call('reviews',body());assert.equal(r.status,413);assert.equal(Object.hasOwn(r.body,'reviewProof'),false);
  });
  it('proof expiration after resolver admission does not pretend to be a commit deadline',async()=>{
    const p=await prepare(),original=h.mongoose.mongo.Collection.prototype.insertOne;
    const spy=mock.method(h.mongoose.mongo.Collection.prototype,'insertOne',function(...args){if(this.collectionName===manifest.collectionName)clock+=301;
      return Reflect.apply(original,this,args);});
    try{assert.equal((await apply(p)).status,201);}finally{spy.mock.restore();}
    assert.equal((await reconcile(p)).body.result,'latest_applied');
  });
  it('verify-only rotation preserves verification but cannot issue, disabled keys reject recovery',async()=>{
    const p=await prepare();config={...config,keyring:{activeKid:null,keys:[{kid:'synthetic',state:'verify_only',key:ring.keys[0].key}]}};configure();
    assert.equal((await call('reviews',body())).status,503);assert.equal((await apply(p)).status,201);
    config={...config,keyring:{activeKid:null,keys:[{kid:'synthetic',state:'disabled'}]}};configure();assert.equal((await reconcile(p)).status,403);
  });
  it('clock-health/readiness failure and quota do not authorize encryption or writes',async()=>{
    const p=await prepare();operational=false;assert.equal((await apply(p)).status,503);assert.equal(await count(),0);
    operational=true;clock=NaN;assert.equal((await call('reviews',body())).status,503);assert.equal((await apply(p)).status,503);
  });
});
