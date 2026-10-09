// Copies the static app into public/ (the dedicated upload directory for Sites).
import { mkdir, copyFile } from 'node:fs/promises';

const FILES = [
    'index.html',
    'google0ce29147459038b5.html'
];

await mkdir('public', { recursive: true });
for (const file of FILES) {
    await copyFile(file, 'public/' + file);
    console.log('copied -> public/' + file);
}
console.log('build ok: public/ ready for deployment');
