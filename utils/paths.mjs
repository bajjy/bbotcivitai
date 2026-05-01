import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const paths = {
  root: path.resolve(__dirname, '..'),
  temp: path.resolve(__dirname, '..', 'temp'),
};

if (!fs.existsSync(paths.temp)) {
  fs.mkdirSync(paths.temp, { recursive: true });
}
