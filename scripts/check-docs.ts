import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateMarkdownDocuments } from './docs-validator.ts';

const ignored = new Set([
  '.git',
  'node_modules',
  'dist',
  '.cache',
  '.pnpm-store',
  'playwright-report',
  'test-results',
]);
const required = [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'README.md',
  'docs/index.md',
  'docs/development.md',
  'docs/workflow.md',
  'docs/product-specs/index.md',
  'docs/product-specs/template.md',
  'docs/product-specs/protocol-simulator-v1.md',
  'docs/design-docs/index.md',
  'docs/design-docs/template.md',
  'docs/design-docs/layered-protocol-v1.md',
  'docs/exec-plans/index.md',
  'docs/exec-plans/template.md',
  'docs/exec-plans/active/index.md',
  'docs/exec-plans/completed/index.md',
  'docs/exec-plans/cancelled/index.md',
  'docs/exec-plans/tech-debt-tracker.md',
];
const root = process.cwd();
const documents = new Map<string, string>();
const paths = new Set<string>();

async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    paths.add(relative);
    if (entry.isDirectory()) await collect(absolute);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      documents.set(relative, await readFile(absolute, 'utf8'));
    }
  }
}

await collect(root);
const diagnostics = validateMarkdownDocuments(documents, paths);
for (const file of required) {
  if (!documents.has(file))
    diagnostics.push({ file, line: 1, message: 'Missing required document' });
}
if (diagnostics.length) {
  for (const item of diagnostics) console.error(`${item.file}:${item.line}: ${item.message}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${documents.size} Markdown documents and their local targets.`);
}
