// Disposable test process; abrupt termination before transaction commit only.
const { DatabaseSync } = require('node:sqlite');
process.once('message', ({ file }) => {
  const db = new DatabaseSync(file); db.exec('BEGIN IMMEDIATE; UPDATE materials SET used=used+1;');
  process.kill(process.pid, 'SIGKILL');
});
