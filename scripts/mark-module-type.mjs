// Marks dual-build output folders so Node reads dist/esm as ESM and dist/cjs as CommonJS.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';
writeFileSync(join(dist, 'esm', 'package.json'), '{ "type": "module" }\n');
writeFileSync(join(dist, 'cjs', 'package.json'), '{ "type": "commonjs" }\n');
