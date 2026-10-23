const path = require('node:path');
const { run } = require('node:test');
const { tap } = require('node:test/reporters');
const { pipeline } = require('node:stream/promises');

const defaults = ['mongodb-integration-safety.test.cjs', 'financial-ownership.integration.test.cjs',
  'recurrence-read.integration.test.cjs', 'classification-persistence.integration.test.cjs',
  'classification-read.integration.test.cjs', 'classification-history.integration.test.cjs', 'classification-protocol.integration.test.cjs', 'classification-operational.integration.test.cjs', 'classification-ubuntu.integration.test.cjs', 'performance-history.integration.test.cjs', 'classification-write.integration.test.cjs']
  .map(filename => path.join(__dirname, filename));

async function main() {
  const files = process.argv.length > 2 ? process.argv.slice(2).map(filename => path.resolve(filename)) : defaults;
  let failed = false;
  const tests = run({ files, concurrency: 1, timeout: 120000 });
  // Node 22 can emit a suite/hook failure while reporting fail=0 and exiting 0.
  // Observe actual failure events, including parent suites, rather than counters
  // or matching diagnostic strings. The built-in TAP reporter retains all output.
  tests.on('test:fail', () => { failed = true; });
  await pipeline(tests.compose(tap), process.stdout, { end: false });
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`Integration test runner failed (${error.name}).\n`);
  process.exitCode = 1;
});
