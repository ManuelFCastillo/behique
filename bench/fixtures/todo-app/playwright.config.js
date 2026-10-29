// Tests may live in the project root or any subfolder; every *.spec.js is picked up.
// The server runs on BENCH_PORT (default 3100) against ./test.db. Tests can read the same path from process.env.DB_PATH.
const path = require('path');
const { defineConfig } = require('@playwright/test');

const PORT = process.env.BENCH_PORT || '3100';
const TEST_DB = path.join(__dirname, 'test.db');
process.env.DB_PATH = TEST_DB;

module.exports = defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',
  testIgnore: ['**/node_modules/**'],
  workers: 1, // all tests share one SQLite file
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: 'node server.js',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    env: { PORT, DB_PATH: TEST_DB, ALLOW_RESET: '1' },
  },
});
