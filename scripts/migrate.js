require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');
(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8'));
  console.log('Schema applied.');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
