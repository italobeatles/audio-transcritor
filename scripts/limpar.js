import fs from 'fs-extra';
import path from 'node:path';

const root = process.cwd();
await fs.emptyDir(path.join(root, 'temp'));
await fs.emptyDir(path.join(root, 'output'));
await fs.ensureFile(path.join(root, 'output', '.gitkeep'));
console.log('Pastas temp/ e output/ limpas.');
