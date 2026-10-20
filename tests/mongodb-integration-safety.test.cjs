const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { testConfiguration, assertOwnedDatabase, openTestDatabase } = require('./helpers/mongodb-integration.cjs');
const safe = { MONGODB_INTEGRATION_TEST: '1', MONGODB_TEST_BASE_URI: 'mongodb://127.0.0.1:27017' };

describe('MongoDB integration configuration guards (no database)', () => {
  for (const [label, value] of [['missing', undefined], ['zero', '0'], ['word', 'true'], ['numeric', 1]]) {
    it(`rejects ${label} opt-in`, () => assert.throws(() => testConfiguration({ ...safe, MONGODB_INTEGRATION_TEST: value }), /MONGODB_INTEGRATION_TEST/));
  }
  for (const [label, value] of [
    ['missing URI', undefined], ['empty URI', ''], ['remote host', 'mongodb://192.0.2.1:27017'],
    ['localhost alias', 'mongodb://localhost:27017'], ['IPv6 alias', 'mongodb://[::1]:27017'],
    ['alternate port', 'mongodb://127.0.0.1:27018'], ['Atlas SRV', 'mongodb+srv://synthetic.example.invalid'],
    ['credentials', 'mongodb://synthetic:synthetic@127.0.0.1:27017'],
    ['production path', 'mongodb://127.0.0.1:27017/production'], ['development path', 'mongodb://127.0.0.1:27017/development'],
    ['budget path', 'mongodb://127.0.0.1:27017/budget'], ['budgetdb path', 'mongodb://127.0.0.1:27017/budgetdb'],
    ['arbitrary path', 'mongodb://127.0.0.1:27017/budget_ownership_it_fake'],
    ['trailing slash', 'mongodb://127.0.0.1:27017/'], ['query options', 'mongodb://127.0.0.1:27017?directConnection=true'],
    ['newline', 'mongodb://127.0.0.1:27017\n'], ['encoded host', 'mongodb://127%2E0%2E0%2E1:27017'],
  ]) {
    it(`rejects ${label} without echoing its value`, () => {
      assert.throws(() => testConfiguration({ ...safe, MONGODB_TEST_BASE_URI: value }), error => {
        assert.equal(error.message, 'MONGODB_TEST_BASE_URI must exactly match the test-only loopback allowlist');
        return true;
      });
    });
  }
  for (const name of ['DATA_BASE_URL', 'DATA_BASE_URL_LOCAL']) {
    it(`rejects reuse of ${name}`, () => assert.throws(() => testConfiguration({ ...safe, [name]: safe.MONGODB_TEST_BASE_URI }), /must not be reused/));
  }
  it('never falls back to application database variables', () => {
    assert.throws(() => testConfiguration({ MONGODB_INTEGRATION_TEST: '1', DATA_BASE_URL: safe.MONGODB_TEST_BASE_URI,
      DATA_BASE_URL_LOCAL: safe.MONGODB_TEST_BASE_URI }), /MONGODB_TEST_BASE_URI/);
  });
  it('generates immutable unique names from cryptographic random bytes', () => {
    const first = testConfiguration(safe); const second = testConfiguration(safe);
    assert.match(first.databaseName, /^budget_ownership_it_[a-f0-9]{32}$/);
    assert.notEqual(first.databaseName, second.databaseName);
    assert.equal(Object.isFrozen(first), true);
  });
  it('rejects unsafe configuration before any Mongoose interaction', async () => {
    const forbidden = new Proxy({}, { get() { throw new Error('Mongoose must not be inspected'); } });
    await assert.rejects(openTestDatabase(forbidden, {}), /MONGODB_INTEGRATION_TEST/);
    await assert.rejects(openTestDatabase(forbidden, { MONGODB_INTEGRATION_TEST: '1' }), /MONGODB_TEST_BASE_URI/);
  });
  it('refuses a pre-existing connection without closing or modifying it', async () => {
    await assert.rejects(openTestDatabase({ connection: { readyState: 1 } }, safe), /existing Mongoose connection/);
  });
  it('requires the exact process-generated name on both Mongoose and driver handles', () => {
    const { databaseName } = testConfiguration(safe);
    const connection = { readyState: 1, name: databaseName, db: { databaseName } };
    assert.doesNotThrow(() => assertOwnedDatabase(connection, databaseName));
    assert.throws(() => assertOwnedDatabase({ ...connection, name: `${databaseName}0` }, databaseName));
    assert.throws(() => assertOwnedDatabase({ ...connection, db: { databaseName: 'budgetdb' } }, databaseName));
    assert.throws(() => assertOwnedDatabase({ ...connection, readyState: 0 }, databaseName));
    assert.throws(() => assertOwnedDatabase(connection, 'production'));
  });
  it('cleanup refuses a changed active database and closes the test-owned connection without dropping', async () => {
    let dropped = 0; let closed = 0;
    // Lifecycle guard stub only. Financial HTTP integration never replaces persistence.
    const connection = { readyState: 0, name: undefined, db: undefined,
      async dropDatabase() { dropped += 1; }, async close() { closed += 1; this.readyState = 0; } };
    const database = await openTestDatabase({ connection, async connect(uri, options) {
      connection.readyState = 1; connection.name = options.dbName; connection.db = { databaseName: options.dbName };
    } }, safe);
    connection.db.databaseName = testConfiguration(safe).databaseName;
    await assert.rejects(database.dispose(), /Active driver database/);
    assert.equal(dropped, 0); assert.equal(closed, 1);
  });
  it('drop failure is fatal and still closes the owned connection', async () => {
    let closed = 0;
    const connection = { readyState: 0,
      async dropDatabase() { throw new Error('Synthetic drop failure'); },
      async close() { closed += 1; this.readyState = 0; } };
    const database = await openTestDatabase({ connection, async connect(uri, options) {
      connection.readyState = 1; connection.name = options.dbName; connection.db = { databaseName: options.dbName };
    } }, safe);
    await assert.rejects(database.dispose(), /Synthetic drop failure/);
    assert.equal(closed, 1);
  });
  it('connection failure still closes the owned handle and suppresses driver details', async () => {
    let closed = 0;
    await assert.rejects(openTestDatabase({ connection: { readyState: 0, async close() { closed += 1; } },
      async connect() { throw new Error('Synthetic driver detail that must not escape'); } }, safe), error => {
      assert.equal(error.message.includes('Synthetic driver detail'), false);
      return true;
    });
    assert.equal(closed, 1);
  });
});
