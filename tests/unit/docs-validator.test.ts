import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMarkdownDocuments } from '../../scripts/docs-validator.ts';

test('validates Korean, duplicate and inline-code headings using GitHub anchors', () => {
  const docs = new Map([
    [
      'README.md',
      '[one](docs/guide.md#계층-선택) [two](docs/guide.md#계층-선택-1) [code](docs/guide.md#run)\n',
    ],
    ['docs/guide.md', '# 계층 선택\n\n## 계층 선택\n\n## `run()`\n'],
  ]);
  assert.deepEqual(validateMarkdownDocuments(docs), []);
});

test('reports missing targets and wrong-case paths at the link line', () => {
  const result = validateMarkdownDocuments(
    new Map([
      ['README.md', '# Intro\n\n[missing](Docs/guide.md)\n'],
      ['docs/guide.md', '# Guide\n'],
    ]),
  );
  assert.equal(result[0]?.line, 3);
  assert.match(result[0]?.message ?? '', /Missing target/);
});

test('checks reference links, images and missing heading fragments', () => {
  const result = validateMarkdownDocuments(
    new Map([
      ['README.md', '[ref][guide]\n\n[guide]: guide.md#absent\n\n![image](absent.png)\n'],
      ['guide.md', '# Guide\n'],
    ]),
  );
  assert.deepEqual(
    result.map((item) => item.message),
    ['Missing anchor: guide.md#absent', 'Missing target: absent.png'],
  );
});

test('allows external links, encoded paths and real non-Markdown targets', () => {
  const docs = new Map([
    ['README.md', '[external](https://example.com/missing) [file](some%20file.ts)\n'],
  ]);
  assert.deepEqual(validateMarkdownDocuments(docs, new Set(['README.md', 'some file.ts'])), []);
});

test('does not treat code examples as real links and permits reusable placeholders only in templates', () => {
  const result = validateMarkdownDocuments(
    new Map([
      ['README.md', '```md\n[fake](missing.md)\n```\n\n{{PROJECT_NAME}}\n'],
      ['docs/template.md', '# {{TASK_TITLE}}\n'],
    ]),
  );
  assert.deepEqual(
    result.map((item) => item.message),
    ['Unfilled project placeholder'],
  );
});

test('reports whitespace, conflict markers and missing final newline', () => {
  const result = validateMarkdownDocuments(new Map([['README.md', '# Guide  \n<<<<<<< conflict']]));
  assert.deepEqual(
    result.map((item) => item.message),
    ['Trailing whitespace', 'Conflict marker', 'Missing final newline'],
  );
});
