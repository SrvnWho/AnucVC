// Loads server/.env before any other module reads process.env.
//
// ES module imports are evaluated before the importing file's own body runs,
// so a dotenv.config() call at the top of server.js still came *after* db.js
// and every other import had already executed - anything those modules read
// from the environment at load time never saw the values in .env. Importing
// this file first in server.js fixes the ordering.
//
// The path is pinned to this file's directory because dotenv defaults to
// process.cwd(), which is wrong whenever the server is started from another
// directory (e.g. a pm2 process started from the repo root).
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });
