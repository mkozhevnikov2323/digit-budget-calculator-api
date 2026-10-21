const {describe,it}=require('node:test');
const assert=require('node:assert/strict');
const {validateManualCommand,validateVerifiedReview,fingerprintClassificationCommand}=require('../dist/domain/classification/writeCommand.js');
const {createClassificationWriteService}=require('../dist/services/classificationWrite.js');
const {syntheticWriteTrust}=require('./helpers/classification-write.cjs');
const a='aaaaaaaaaaaaaaaaaaaaaaaa',op='111111111111111111111111';
const requestId='12345678-1234-4234-8234-123456789abc';
const command=(extra={})=>({kind:'manual_classification',dataset:'expenses',operationId:op,state:'approved',
  assignment:{economicRole:'ordinary_expense',layer:'everyday'},expectedRevision:null,requestId,...extra});
const review=(extra={})=>({kind:'verified_manual_review',owner:a,dataset:'expenses',operationId:op,
  sourceFingerprint:'a'.repeat(64),sourceFingerprintVersion:1,...extra});
const absent=(state,extra={})=>{const x=command({state,...extra});delete x.assignment;return x;};
const code=(result,expected)=>{assert.equal(result.ok,false);assert.equal(result.error.code,expected);};

describe('strict internal manual command boundary (pure)',()=>{
  it('accepts all manual states with explicit initial or positive expected revisions',()=>{
    for(const x of [command(),command({expectedRevision:1}),absent('cleared'),absent('explicit_unclassified',{expectedRevision:9})])
      assert.equal(validateManualCommand(x).ok,true);
  });
  for(const [label,change] of [
    ['null',()=>null],['array',()=>[]],['class',()=>new(class {})()],['inherited',x=>Object.create(x)],
    ['missing kind',x=>{delete x.kind;return x;}],['automatic intent',x=>({...x,kind:'automatic_classification'})],
    ['unknown dataset',x=>({...x,dataset:'other'})],['short ID',x=>({...x,operationId:'123'})],
    ['nonhex ID',x=>({...x,operationId:'z'.repeat(24)})],['newline ID',x=>({...x,operationId:op+'\n'})],
    ['missing expected revision',x=>{delete x.expectedRevision;return x;}],['undefined revision',x=>({...x,expectedRevision:undefined})],
    ...[0,-1,1.5,'1',NaN,Infinity,Number.MAX_SAFE_INTEGER+1].map((value,i)=>['invalid revision '+i,x=>({...x,expectedRevision:value})]),
    ['unknown state',x=>({...x,state:'stale'})],['missing assignment',x=>{delete x.assignment;return x;}],
    ['null assignment',x=>({...x,assignment:null})],['unknown layer',x=>({...x,assignment:{economicRole:'ordinary_expense',layer:'invalid'}})],
    ['wrong role/dataset',x=>({...x,assignment:{economicRole:'ordinary_income',layer:null}})],
    ['cleared with assignment',x=>({...x,state:'cleared'})],['unclassified with assignment',x=>({...x,state:'explicit_unclassified'})],
    ['nested unknown field',x=>({...x,assignment:{...x.assignment,extra:1}})],
    ['nested accessor',x=>({...x,assignment:{economicRole:'ordinary_expense',get layer(){throw new Error('Forbidden getter');}}})],
    ...['_id','owner','taxonomyVersion','decisionOrigin','decisionRevision','lastMutation','createdAt','updatedAt','sourceObservedAt',
      'sourceFingerprint','sourceFingerprintVersion','$set','filter','replacement'].map(key=>['forbidden '+key,x=>({...x,[key]:'fictional'})]),
    ['toJSON hook',x=>({...x,toJSON(){throw new Error('Forbidden hook');}})],
    ['accessor',x=>Object.defineProperty(x,'requestId',{enumerable:true,get(){throw new Error('Forbidden getter');}})],
    ['hidden field',x=>Object.defineProperty(x,'hidden',{value:1})],['symbol',x=>({...x,[Symbol('extra')]:true})],
    ['throwing proxy',()=>new Proxy({},{ownKeys(){throw new Error('Fictional private exception');}})],
  ])it('rejects '+label+' without private error data',()=>{
    const result=validateManualCommand(change(command()));code(result,'invalid_command');assert.deepEqual(Object.keys(result.error),['code']);
  });
  for(const [label,id] of [['uppercase',requestId.toUpperCase()],['wrong version',requestId.replace('-4234-','-1234-')],
    ['wrong variant',requestId.replace('-8234-','-7234-')],['newline',requestId+'\n'],['missing',undefined],['nonstring',{}]])
    it('rejects '+label+' UUID-v4',()=>code(validateManualCommand(command({requestId:id})),'invalid_command'));
  it('does not mutate input and owns the checked assignment snapshot',()=>{
    const x=command(),before=structuredClone(x),checked=validateManualCommand(x);assert.equal(checked.ok,true);assert.deepEqual(x,before);
    x.assignment.layer='irregular';assert.equal(checked.value.assignment.layer,'everyday');assert.equal(Object.isFrozen(checked.value.assignment),true);
  });
  it('accepts null-prototype plain objects and canonical uppercase IDs',()=>{
    const result=validateManualCommand(Object.assign(Object.create(null),command({operationId:'ABCDEFABCDEFABCDEFABCDEF'})));
    assert.equal(result.ok,true);assert.equal(result.value.operationId,'abcdefabcdefabcdefabcdef');
  });
});

describe('internal verified-review shape is not authentication',()=>{
  it('checks exact identities and owns its immutable snapshot',()=>{
    const input=review({owner:a.toUpperCase()}),result=validateVerifiedReview(input);assert.equal(result.ok,true);input.owner='b'.repeat(24);
    assert.equal(result.value.owner,a);assert.equal(Object.isFrozen(result.value),true);
  });
  for(const [label,change]of [
    ['missing',()=>undefined],['unverified kind',x=>({...x,kind:'client_review'})],['invalid owner',x=>({...x,owner:'other'})],
    ['wrong dataset',x=>({...x,dataset:'other'})],['invalid operation',x=>({...x,operationId:op+'\n'})],
    ['extra field',x=>({...x,confirmed:true})],['invalid digest',x=>({...x,sourceFingerprint:'bad'})],
    ['uppercase digest',x=>({...x,sourceFingerprint:'A'.repeat(64)})],['getter',x=>Object.defineProperty(x,'sourceFingerprint',{enumerable:true,get(){throw new Error('Forbidden');}})],
    ['prototype',x=>Object.create(x)],['toJSON',x=>({...x,toJSON(){throw new Error('Forbidden');}})],
  ])it('rejects '+label,()=>code(validateVerifiedReview(change(review())),'invalid_review'));
  for(const version of [undefined,0,2,'1'])it('rejects unsupported source version '+String(version),()=>
    code(validateVerifiedReview(review({sourceFingerprintVersion:version})),'unsupported_fingerprint_version'));
});

describe('RFC command SHA-256 v1 (independent Python hashlib vectors)',()=>{
  const vectors=[
  {
    "dataset": "expenses",
    "state": "approved",
    "expectedRevision": null,
    "sourceFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "hash": "43545a04c2ea08897a1da1d1680bddcfa87e5f1a37cbdf4b893aaa5d357d39e2"
  },
  {
    "dataset": "expenses",
    "state": "approved",
    "expectedRevision": 1,
    "sourceFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "hash": "ae15a20e00bc4369c2dbdab657dfc3634b63af38e247275ac639cb91ef9b3658"
  },
  {
    "dataset": "incomes",
    "state": "approved",
    "expectedRevision": 7,
    "sourceFingerprint": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "hash": "f95f10fb102c3fe40813af45a294d8e328c65e2125ab59e58ed15d0b1031ff86"
  },
  {
    "dataset": "expenses",
    "state": "explicit_unclassified",
    "expectedRevision": null,
    "sourceFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "hash": "83b375a10032d8aebb26b43dbac49945adebb2c87ba9910a970a5df36eb47d74"
  },
  {
    "dataset": "expenses",
    "state": "cleared",
    "expectedRevision": 9007199254740990,
    "sourceFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "hash": "f5c3d5b14eea24995fce47f3a127c3fd4c1471a4fa5afb908999b24f35638f74"
  }
];
  for(const [i,v]of vectors.entries())it('matches fixed vector '+i,()=>{
    const x=v.state==='approved'?command({dataset:v.dataset,state:v.state,expectedRevision:v.expectedRevision,
      assignment:v.dataset==='expenses'?{economicRole:'ordinary_expense',layer:i===1?'irregular':'everyday'}:{economicRole:'ordinary_income',layer:null}})
      :absent(v.state,{expectedRevision:v.expectedRevision});
    const result=fingerprintClassificationCommand(a,x,review({dataset:v.dataset,sourceFingerprint:v.sourceFingerprint}),1);
    assert.equal(result.ok,true);assert.equal(result.value.commandFingerprint===v.hash,true,'Independent fixed vector mismatch');
    assert.equal(result.value.commandFingerprintVersion,1);
  });
  it('is deterministic, order independent and canonicalizes identity aliases',()=>{
    const x=command(),r=review(),first=fingerprintClassificationCommand(a,x,r,1);
    const reordered=Object.fromEntries(Object.entries(x).reverse());
    assert.deepEqual(fingerprintClassificationCommand(a.toUpperCase(),reordered,review({owner:a.toUpperCase()}),1),first);
  });
  for(const [label,x,r,owner]of [
    ['request ID',command({requestId:'87654321-4321-4321-8321-cba987654321'}),review(),a],
    ['revision',command({expectedRevision:1}),review(),a],
    ['assignment',command({assignment:{economicRole:'ordinary_expense',layer:'irregular'}}),review(),a],
    ['state',absent('cleared'),review(),a],
    ['source digest',command(),review({sourceFingerprint:'b'.repeat(64)}),a],
    ['owner',command(),review({owner:'b'.repeat(24)}),'b'.repeat(24)],
    ['operation ID',command({operationId:'2'.repeat(24)}),review({operationId:'2'.repeat(24)}),a],
    ['dataset',command({dataset:'incomes',assignment:{economicRole:'ordinary_income',layer:null}}),review({dataset:'incomes'}),a],
  ])it('binds '+label,()=>{
    const first=fingerprintClassificationCommand(a,command(),review(),1),changed=fingerprintClassificationCommand(owner,x,r,1);
    assert.equal(changed.ok,true);assert.notEqual(changed.value.commandFingerprint,first.value.commandFingerprint);
  });
  it('rejects mismatched owner/operation/dataset and unsupported command versions',()=>{
    for(const r of [review({owner:'b'.repeat(24)}),review({operationId:'2'.repeat(24)}),review({dataset:'incomes'})])
      code(fingerprintClassificationCommand(a,command(),r,1),'review_mismatch');
    for(const v of [undefined,2,'1'])code(fingerprintClassificationCommand(a,command(),review(),v),'unsupported_fingerprint_version');
  });
  it('does not execute inherited serialization hooks or mutate input',()=>{
    const x=Object.freeze(command()),r=Object.freeze(review());let calls=0;
    const original=Object.getOwnPropertyDescriptor(Object.prototype,'toJSON');
    Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){calls++;throw new Error('Forbidden hook');}});
    let result;try{result=fingerprintClassificationCommand(a,x,r,1);}finally{
      if(original)Object.defineProperty(Object.prototype,'toJSON',original);else delete Object.prototype.toJSON;
    }
    assert.equal(result.ok,true);assert.equal(calls,0);
  });
});

describe('disconnected write service trust boundary (database forbidden)',()=>{
  const setup=()=>{
    const trust=syntheticWriteTrust(),context=trust.owner(a),evidence=trust.review(context,review());
    let dbAccess=0;const connection={readyState:0,get db(){dbAccess++;throw new Error('Forbidden database');}};
    return {trust,context,evidence,service:createClassificationWriteService(connection,trust.boundary),noDB:()=>assert.equal(dbAccess,0)};
  };
  it('requires explicit server trust adapters; has no default identity resolver',()=>{
    assert.throws(()=>createClassificationWriteService({},undefined),{message:'Classification write trust boundary required'});
  });
  it('never treats a raw client owner/JWT-like object as an authenticated context',async()=>{
    const h=setup();for(const x of [a,{owner:a},{_id:a},null])code(await h.service.execute(x,command(),h.evidence),'invalid_context');h.noDB();
  });
  it('never treats a raw client fingerprint/JSON copy as verified review evidence',async()=>{
    const h=setup();for(const x of [review(),JSON.parse(JSON.stringify(h.evidence)),undefined])
      code(await h.service.execute(h.context,command(),x),'invalid_review');h.noDB();
  });
  it('rejects review from another identity even if a trusted resolver admits its shape',async()=>{
    const h=setup();const other=h.trust.owner('b'.repeat(24)),evidence=h.trust.review(other,review({owner:'b'.repeat(24)}));
    code(await h.service.execute(h.context,command(),evidence),'review_mismatch');h.noDB();
  });
  it('does not compute source hashes to manufacture missing review proof',async()=>{
    const h=setup();code(await h.service.execute(h.context,command(),undefined),'invalid_review');h.noDB();
  });
  it('refuses recurrence observations and AI suggestions without a strict manual command',async()=>{
    const h=setup();for(const x of [{version:'observations-v0',observations:[]},{kind:'ai_suggestion',assignment:command().assignment},
      {...command(),kind:'recurrence_observation'},undefined])code(await h.service.execute(h.context,x,h.evidence),'invalid_command');h.noDB();
  });
  it('fails closed on a disconnected explicit connection without connecting or consulting env',async()=>{
    const h=setup();code(await h.service.execute(h.context,command(),h.evidence),'infrastructure_unavailable');h.noDB();
  });
  it('passes a validated immutable command to the trusted manual-review verifier',async()=>{
    let checked;
    const service=createClassificationWriteService({readyState:0},{resolveAuthenticatedOwner:()=>({owner:a}),
      resolveVerifiedReview(context,evidence,c){checked=c;return review();}});
    code(await service.execute({},command(),{}),'infrastructure_unavailable');
    assert.equal(Object.isFrozen(checked),true);assert.equal(Object.isFrozen(checked.assignment),true);
    assert.equal(checked.kind,'manual_classification');
  });
  it('sanitizes unexpected connection/driver-boundary exceptions',async()=>{
    const service=createClassificationWriteService({readyState:1,get db(){throw new Error('Fictional private password');}},
      {resolveAuthenticatedOwner:()=>({owner:a}),resolveVerifiedReview:()=>review()});
    const result=await service.execute({},command(),{});code(result,'persistence_failure');assert.equal(result.persistence,'unknown');
  });
  it('sanitizes trusted-resolver exceptions and invalid resolver outputs',async()=>{
    const broken=createClassificationWriteService({readyState:0},{resolveAuthenticatedOwner(){throw new Error('Fictional private details');},resolveVerifiedReview(){}});
    code(await broken.execute({},command(),{}),'invalid_context');
    const brokenReview=createClassificationWriteService({readyState:0},{resolveAuthenticatedOwner:()=>({owner:a}),resolveVerifiedReview(){throw new Error('Fictional private details');}});
    code(await brokenReview.execute({},command(),{}),'invalid_review');
  });
});
