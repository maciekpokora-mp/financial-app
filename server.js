const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const { calculate, getDefaultParams } = require('./engine');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Database setup - use persistent volume on Railway if available
const dbDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(dbDir, 'scenarios.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS scenarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    params TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// GET default parameters
app.get('/api/defaults', (req, res) => {
  res.json(getDefaultParams());
});

// POST calculate
app.post('/api/calculate', (req, res) => {
  try {
    const result = calculate(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET all scenarios
app.get('/api/scenarios', (req, res) => {
  const rows = db.prepare('SELECT id, name, created_at, updated_at FROM scenarios ORDER BY updated_at DESC').all();
  res.json(rows);
});

// GET single scenario
app.get('/api/scenarios/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Scenariusz nie znaleziony' });
  res.json({ ...row, params: JSON.parse(row.params) });
});

// POST save scenario
app.post('/api/scenarios', (req, res) => {
  const { name, params } = req.body;
  if (!name || !params) return res.status(400).json({ error: 'Nazwa i parametry są wymagane' });
  try {
    const existing = db.prepare('SELECT id FROM scenarios WHERE name = ?').get(name);
    if (existing) {
      db.prepare('UPDATE scenarios SET params = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(params), existing.id);
      res.json({ id: existing.id, message: 'Scenariusz zaktualizowany' });
    } else {
      const result = db.prepare('INSERT INTO scenarios (name, params) VALUES (?, ?)')
        .run(name, JSON.stringify(params));
      res.json({ id: result.lastInsertRowid, message: 'Scenariusz zapisany' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE scenario
app.delete('/api/scenarios/:id', (req, res) => {
  db.prepare('DELETE FROM scenarios WHERE id = ?').run(req.params.id);
  res.json({ message: 'Scenariusz usunięty' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
