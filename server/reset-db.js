import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'anucvc.db');
const db = new Database(dbPath);

console.log('🔄 SQLite Veritabanı Temizleniyor...');

db.exec('DELETE FROM users;');
db.exec('DELETE FROM messages;');
db.exec('DELETE FROM rooms;');

const stmt = db.prepare('INSERT INTO rooms (id, name, type) VALUES (?, ?, ?)');
stmt.run('genel', 'genel', 'text');
stmt.run('duyurular', 'duyurular', 'text');
stmt.run('ses-1', '🔊 Ses Odası 1', 'voice');
stmt.run('ses-2', '🔊 Ses Odası 2', 'voice');

console.log('✅ SQLite Veritabanı Sıfırlandı! Yalnızca varsayılan temiz kanallar bırakıldı.');
process.exit(0);
