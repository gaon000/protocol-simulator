import path from 'node:path';
import GithubSlugger from 'github-slugger';
import type { Root, RootContent } from 'mdast';
import { toString as markdownText } from 'mdast-util-to-string';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

type MarkdownNode = Root | RootContent;
const parser = unified().use(remarkParse).use(remarkGfm);

function walk(node: MarkdownNode, visitor: (item: MarkdownNode) => void): void {
  visitor(node);
  if ('children' in node) {
    for (const child of node.children) walk(child, visitor);
  }
}

function headingAnchors(tree: Root): Set<string> {
  const result = new Set<string>();
  const slugger = new GithubSlugger();
  walk(tree, (node) => {
    if (node.type === 'heading') result.add(slugger.slug(markdownText(node)));
    if (node.type === 'html') {
      for (const match of node.value.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
        if (match[1]) result.add(match[1]);
      }
    }
  });
  return result;
}

/** Validate exact local paths, GitHub heading anchors and applied-document hygiene. */
export function validateMarkdownDocuments(
  documents: ReadonlyMap<string, string>,
  existingPaths: ReadonlySet<string> = new Set(documents.keys()),
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const trees = new Map([...documents].map(([file, content]) => [file, parser.parse(content)]));
  const anchors = new Map([...trees].map(([file, tree]) => [file, headingAnchors(tree)]));

  for (const [file, tree] of trees) {
    const definitions = new Map<string, string>();
    walk(tree, (node) => {
      if (node.type === 'definition' && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
    });
    walk(tree, (node) => {
      let url: string | undefined;
      if (node.type === 'link' || node.type === 'image') url = node.url;
      if (node.type === 'linkReference' || node.type === 'imageReference') {
        url = definitions.get(node.identifier);
      }
      if (url === undefined || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return;
      let destination: string;
      let fragment: string;
      try {
        const hash = url.indexOf('#');
        const address = hash < 0 ? url : url.slice(0, hash);
        destination = decodeURIComponent(address.split('?')[0] ?? '');
        fragment = hash < 0 ? '' : decodeURIComponent(url.slice(hash + 1));
      } catch {
        diagnostics.push({
          file,
          line: node.position?.start.line ?? 1,
          message: `Invalid URL: ${url}`,
        });
        return;
      }
      const target = (
        destination === ''
          ? file
          : path.posix.normalize(
              destination.startsWith('/')
                ? destination.slice(1)
                : path.posix.join(path.posix.dirname(file), destination),
            )
      ).replace(/\/$/, '');
      const targetAnchors = anchors.get(target);
      if (!existingPaths.has(target)) {
        diagnostics.push({
          file,
          line: node.position?.start.line ?? 1,
          message: `Missing target: ${url}`,
        });
      } else if (fragment && targetAnchors && !targetAnchors.has(fragment)) {
        diagnostics.push({
          file,
          line: node.position?.start.line ?? 1,
          message: `Missing anchor: ${url}`,
        });
      }
    });

    const content = documents.get(file) ?? '';
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      if (/[\t ]+$/.test(line))
        diagnostics.push({ file, line: index + 1, message: 'Trailing whitespace' });
      if (/^(?:<{7}|={7}|>{7})/.test(line))
        diagnostics.push({ file, line: index + 1, message: 'Conflict marker' });
      if (path.posix.basename(file) !== 'template.md' && /\{\{[^{}]+\}\}/.test(line)) {
        diagnostics.push({ file, line: index + 1, message: 'Unfilled project placeholder' });
      }
    }
    if (!content.endsWith('\n'))
      diagnostics.push({ file, line: lines.length, message: 'Missing final newline' });
  }
  return diagnostics;
}
