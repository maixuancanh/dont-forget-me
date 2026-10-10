import pg from 'pg';
import {PostgresRepository} from '../src/persistence/repository.js';
import {assertTestDatabase} from '../src/persistence/transactions.js';
const test=process.argv.includes('--test');
// Deliberately no dotenv: the test runner must never discover real credentials from .env.
const url=test?(process.env.DFM_TEST_DATABASE_URL??'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test'):process.env.DATABASE_URL;
if(!url)throw new Error('DATABASE_URL_REQUIRED');
if(test)assertTestDatabase(url);
const pool=new pg.Pool({connectionString:url});
try {
  const repository=new PostgresRepository(pool);await repository.migrate();
  if(process.argv.includes('--import-legacy')) {
    if(!process.argv.includes('--offline-import-confirmed'))throw new Error('OFFLINE_IMPORT_CONFIRMATION_REQUIRED');
    await repository.importLegacyTable();
  }
  console.log(JSON.stringify({migration:'001_memory_v2',database:test?'isolated-test':'configured',legacyImported:process.argv.includes('--import-legacy')}));
} finally {await pool.end();}
