import { DatabaseSync } from 'node:sqlite';

const database = new DatabaseSync('visits.db');
database.exec('CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, path TEXT NOT NULL, at TEXT NOT NULL)');

const insert = database.prepare('INSERT INTO visits (path, at) VALUES (?, ?)');
for (const path of ['/', '/pricing', '/']) insert.run(path, new Date().toISOString());

const counts = database.prepare('SELECT path, COUNT(*) AS hits FROM visits GROUP BY path ORDER BY hits DESC').all();
console.log(JSON.stringify(counts));
database.close();
