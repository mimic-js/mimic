// Prints a Markdown table of a pool run: node report.mjs <pool.json> <out-dir>
import { existsSync, readFileSync } from 'node:fs';

const [poolPath, outDir] = process.argv.slice(2);
const { apps } = JSON.parse(readFileSync(poolPath, 'utf8'));
const notes = existsSync(new URL('./notes.json', import.meta.url))
  ? JSON.parse(readFileSync(new URL('./notes.json', import.meta.url), 'utf8'))
  : {};

const MARK = { pass: '✅', 'sandbox-blocked': '⚪', 'source-incomplete': '⚪' };
const counts = {};
const categories = {};
const rows = [];
for (const app of apps) {
  const file = `${outDir}/results/${app.id}.json`;
  const result = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { status: 'not-run' };
  const status = notes[app.id]?.status ?? result.status;
  counts[status] = (counts[status] ?? 0) + 1;
  const source = `\`${app.repo}${app.ref ? `@${app.ref}` : ''}${app.dir ? `/${app.dir}` : ''}\``;
  const commands = [...(app.setup ?? []), app.dev].map((command) => `\`${command}\``).join(' → ');
  const why = notes[app.id]?.why ?? '';
  const category = notes[app.id]?.category ?? '';
  if (status !== 'pass' && category) categories[category] = (categories[category] ?? 0) + 1;
  rows.push(`| ${app.id} | ${app.stack} | ${app.title} | ${source} | ${commands} | ${MARK[status] ?? '❌'} ${status} | ${result.seconds ?? ''} | ${category} | ${why.replace(/\|/g, '\\|')} |`);
}
console.log(Object.entries(counts).map(([status, count]) => `${status}: ${count}`).join(', '));
console.log(Object.entries(categories).sort((a, b) => b[1] - a[1]).map(([category, count]) => `${category}: ${count}`).join(', '));
console.log('\n| id | Stack | Application | Source | Commands | Result | s | Cause | Why |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
console.log(rows.join('\n'));
