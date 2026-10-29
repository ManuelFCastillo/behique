// Tiny server: serves index.html and a todo API backed by SQLite (node:sqlite, no deps).
//   npm start            -> http://localhost:3100, data in todos.db
//   sqlite3 todos.db     -> poke at the data while the page is open
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3100;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'todos.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const toClient = row => ({ id: row.id, text: row.text, done: row.done === 1 });

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const idMatch = url.pathname.match(/^\/api\/todos\/(\d+)$/);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }

    if (req.method === 'GET' && url.pathname === '/api/todos') {
      const rows = db.prepare('SELECT id, text, done FROM todos ORDER BY id').all();
      return send(res, 200, rows.map(toClient));
    }

    if (req.method === 'POST' && url.pathname === '/api/todos') {
      const { text } = await readJson(req);
      if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'text is required' });
      const info = db.prepare('INSERT INTO todos (text) VALUES (?)').run(text.trim());
      const row = db.prepare('SELECT id, text, done FROM todos WHERE id = ?').get(info.lastInsertRowid);
      return send(res, 201, toClient(row));
    }

    if (req.method === 'PATCH' && idMatch) {
      const { done } = await readJson(req);
      const info = db.prepare('UPDATE todos SET done = ? WHERE id = ?').run(done ? 1 : 0, Number(idMatch[1]));
      return send(res, info.changes ? 200 : 404, info.changes ? { ok: true } : { error: 'not found' });
    }

    if (req.method === 'DELETE' && idMatch) {
      const info = db.prepare('DELETE FROM todos WHERE id = ?').run(Number(idMatch[1]));
      return send(res, info.changes ? 204 : 404, info.changes ? undefined : { error: 'not found' });
    }

    // Test helper: wipe the table. Only on when the test config sets ALLOW_RESET=1.
    if (req.method === 'POST' && url.pathname === '/api/reset' && process.env.ALLOW_RESET) {
      db.exec("DELETE FROM todos; DELETE FROM sqlite_sequence WHERE name = 'todos'");
      return send(res, 204);
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}  (db: ${DB_PATH})`));
