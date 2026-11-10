import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sourceIcon = path.join(__dirname, 'src-tauri/icons/anucord.png');

try {
  console.log('Generating Tauri icons from anucord.png...');
  execSync(`npx @tauri-apps/cli icon "${sourceIcon}"`, { stdio: 'inherit', cwd: __dirname });
  console.log('✅ Icons updated successfully from src-tauri/icons/anucord.png!');
} catch (err) {
  console.error('Failed to generate icons:', err);
}
