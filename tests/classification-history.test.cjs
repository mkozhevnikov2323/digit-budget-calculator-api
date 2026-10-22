const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { parseClassificationJson, isClassificationPost } = require('../dist/middlewares/classificationTransport');
const { presentSource, effectiveClassification } = require('../dist/services/classificationObservation');
const identity = { owner: 'a'.repeat(24), dataset: 'expenses', operationId: '1'.repeat(24) };
const source = () => ({ _id: new Types.ObjectId(identity.operationId), owner: new Types.ObjectId(identity.owner),
  amount: 12.34, date: new Date(1736942400001), category: 'Транспорт', title: 'Fuel', recipient: 'Fictional' });
describe('bounded new classification transport', () => {
  it('accepts ordinary JSON, nested arrays, escaped quotes and comma strings', () => {
    for (const x of [{ operations: [{ dataset: 'expenses', operationId: '1'.repeat(24) }] }, { text: 'a\\"{},:b' }, [], null, true, 0])
      assert.deepEqual(parseClassificationJson(JSON.stringify(x)), x);
  });
  for (const [label, raw] of [['duplicate', '{"a":1,"a":2}'], ['escaped duplicate', '{"a":1,"\\u0061":2}'],
    ['nested duplicate', '{"b":{"a":1,"a":2}}'], ['invalid', '{'], ['depth', '['.repeat(18)+'0'+']'.repeat(18)]])
    it('rejects ' + label + ' without echoing input', () => { let failed=false;try{parseClassificationJson(raw);}catch{failed=true;}assert.equal(failed,true); });
  it('targets only the new POST routes', () => {
    for (const path of ['/classifications/history/read','/classifications/expenses/id/reviews','/classifications/incomes/id/commands',
      '/classifications/expenses/id/commands/reconcile']) assert.equal(isClassificationPost('POST',path),true);
    assert.equal(isClassificationPost('GET','/classifications/expenses/id'),false);
    assert.equal(isClassificationPost('POST','/expenses'),false);
  });
});
describe('same-observation source projection', () => {
  it('returns exact source facts, private digest separate and no document metadata', () => {
    const x=presentSource(source(),identity); assert.equal(!!x,true);
    assert.equal(x.facts.dateEpochMs,1736942400001); assert.equal(x.facts.date,'2025-01-15T12:00:00.001Z');
    assert.equal(x.facts.amount.value,'12.34'); assert.deepEqual(x.facts.comment,{kind:'missing'});
    for (const key of ['owner','_id','sourceFingerprint','lastMutation']) assert.equal(Object.hasOwn(x.facts,key),false);
  });
  for (const amount of [-0,0,0.1+0.2,Number.MAX_VALUE]) it('preserves binary64 representation case '+String(Object.is(amount,-0)?'negative zero':amount),()=>{
    const x=presentSource({...source(),amount},identity);assert.equal(!!x,true);
    assert.equal(Object.is(Number(x.facts.amount.value),amount),true);
  });
  it('distinguishes missing/null/empty and Unicode normalization',()=>{
    const variants=[source(),{...source(),comment:null},{...source(),comment:''},{...source(),comment:'é'},{...source(),comment:'e\u0301'}];
    assert.equal(new Set(variants.map(x=>JSON.stringify(presentSource(x,identity).facts))).size,5);
    assert.equal(new Set(variants.map(x=>presentSource(x,identity).fingerprint.sourceFingerprint)).size,5);
  });
  for (const [label,edit] of [['long string',x=>({...x,title:'x'.repeat(8193)})], ['lone surrogate',x=>({...x,title:'\ud800'})],
    ['bad date',x=>({...x,date:new Date(NaN)})],['foreign',x=>({...x,owner:new Types.ObjectId('b'.repeat(24))})],
    ['unexpected',x=>({...x,extra:true})],['getter',x=>Object.defineProperty(x,'amount',{get(){throw Error('Forbidden');},enumerable:true})]])
    it('rejects '+label,()=>assert.equal(presentSource(edit(source()),identity),null));
  it('missing and blocked classifications never invent confirmed assignments',()=>{
    const f=presentSource(source(),identity).fingerprint;
    assert.equal(effectiveClassification(null,identity.owner,identity.dataset,identity.operationId,f).status,'unreviewed');
    const blocked=effectiveClassification({},identity.owner,identity.dataset,identity.operationId,f);
    assert.equal(blocked.status,'blocked');assert.equal(blocked.confirmed,null);
  });
});
