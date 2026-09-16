#!/usr/bin/env node
// PROTOTYPE — bundle src/client/index.tsx into lib/client.js in the web
// client's lazy-CJS handoff format (pattern copied from dsh-voice-call):
// window.__ModuleLoader__.load({ id, factory }); all @deepseek-ai/* and
// react imports stay external (the browser module table provides them).
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const result = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime', 'react-dom/*'],
  minify: true,
  write: false,
  logLevel: 'warning',
});

const body = result.outputFiles[0]?.text ?? '';
if (body === '') throw new Error('build-client: esbuild produced no output');

const wrapped = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(pkg.name)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  body,
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n');

await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib/client.js'), wrapped, 'utf8');
process.stdout.write(`build-client: wrote ${pkg.name} bundle (${Buffer.byteLength(wrapped)} bytes)\n`);
