/*
 * Adapted from Paseo's @getpaseo/highlight 0.14.0 (packages/highlight/src/syntax-roles.ts, parsers.ts, highlighter.ts),
 * Copyright (c) 2025-present Mohamed Boudra, licensed under the Apache License, Version 2.0.
 * ALP web cannot bundle Paseo packages (build/browser-boundary.js), so the parts it uses are
 * carried here unchanged in substance: the Lezer tags mapped to
 * roles, the parsers by file extension (Svelte, Astro, Vue, C#, Nix and Elixir left out, as their
 * grammars live in Paseo's own package) and the line tokenizer.
 */

import { defineLanguageFacet, Language, StreamLanguage } from '@codemirror/language';
import { dart } from '@codemirror/legacy-modes/mode/clike';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import type { Parser, Tree } from '@lezer/common';
import { highlightTree, tagHighlighter, tags, type Tag } from '@lezer/highlight';
import { parser as cppParser } from '@lezer/cpp';
import { parser as cssParser } from '@lezer/css';
import { parser as goParser } from '@lezer/go';
import { parser as htmlParser } from '@lezer/html';
import { parser as javaParser } from '@lezer/java';
import { parser as jsParser } from '@lezer/javascript';
import { parser as jsonParser } from '@lezer/json';
import { parser as markdownParser } from '@lezer/markdown';
import { parser as phpParser } from '@lezer/php';
import { parser as pythonParser } from '@lezer/python';
import { parser as rustParser } from '@lezer/rust';
import { parser as xmlParser } from '@lezer/xml';
import { parser as yamlParser } from '@lezer/yaml';
import type { HighlightStyle, HighlightToken } from './palettes';

export const syntaxRoleTags: ReadonlyArray<{ tag: Tag; role: HighlightStyle }> = [
  { tag: tags.keyword, role: "keyword" },
  { tag: tags.controlKeyword, role: "keyword" },
  { tag: tags.operatorKeyword, role: "keyword" },
  { tag: tags.definitionKeyword, role: "keyword" },
  { tag: tags.moduleKeyword, role: "keyword" },
  { tag: tags.comment, role: "comment" },
  { tag: tags.lineComment, role: "comment" },
  { tag: tags.blockComment, role: "comment" },
  { tag: tags.docComment, role: "comment" },
  { tag: tags.string, role: "string" },
  { tag: tags.special(tags.string), role: "string" },
  { tag: tags.number, role: "number" },
  { tag: tags.integer, role: "number" },
  { tag: tags.float, role: "number" },
  { tag: tags.bool, role: "literal" },
  { tag: tags.null, role: "literal" },
  { tag: tags.function(tags.variableName), role: "function" },
  { tag: tags.function(tags.propertyName), role: "function" },
  { tag: tags.definition(tags.variableName), role: "definition" },
  { tag: tags.definition(tags.propertyName), role: "definition" },
  { tag: tags.definition(tags.function(tags.variableName)), role: "definition" },
  { tag: tags.className, role: "class" },
  { tag: tags.definition(tags.className), role: "class" },
  { tag: tags.typeName, role: "type" },
  { tag: tags.tagName, role: "tag" },
  { tag: tags.attributeName, role: "attribute" },
  { tag: tags.attributeValue, role: "string" },
  { tag: tags.propertyName, role: "property" },
  { tag: tags.variableName, role: "variable" },
  { tag: tags.local(tags.variableName), role: "variable" },
  { tag: tags.special(tags.variableName), role: "variable" },
  { tag: tags.operator, role: "operator" },
  { tag: tags.punctuation, role: "punctuation" },
  { tag: tags.bracket, role: "punctuation" },
  { tag: tags.separator, role: "punctuation" },
  { tag: tags.regexp, role: "regexp" },
  { tag: tags.escape, role: "escape" },
  { tag: tags.meta, role: "meta" },
  { tag: tags.heading, role: "heading" },
  { tag: tags.link, role: "link" },
  { tag: tags.url, role: "link" },
];

export const staticSyntaxHighlighter = tagHighlighter(
  syntaxRoleTags.map(({ tag, role }) => ({ tag, class: role })),
);


function language(parser: Parser): Language {
  return new Language(defineLanguageFacet(), parser);
}

const languagesByExtension: Record<string, Language> = {
  js: language(jsParser), jsx: language(jsParser.configure({ dialect: 'jsx' })),
  ts: language(jsParser.configure({ dialect: 'ts' })), tsx: language(jsParser.configure({ dialect: 'ts jsx' })),
  mjs: language(jsParser), cjs: language(jsParser),
  c: language(cppParser), h: language(cppParser), cc: language(cppParser), cpp: language(cppParser), cxx: language(cppParser),
  hpp: language(cppParser), hxx: language(cppParser), m: language(cppParser), mm: language(cppParser),
  json: language(jsonParser),
  css: language(cssParser), scss: language(cssParser),
  html: language(htmlParser), htm: language(htmlParser),
  xml: language(xmlParser),
  java: language(javaParser),
  py: language(pythonParser),
  go: language(goParser),
  php: language(phpParser),
  yaml: language(yamlParser), yml: language(yamlParser),
  rs: language(rustParser),
  swift: StreamLanguage.define(swift),
  dart: StreamLanguage.define(dart),
  md: language(markdownParser), mdx: language(markdownParser),
};

export function getParserForFile(filename: string): Parser | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  return (ext && languagesByExtension[ext]?.parser) || null;
}

export function isLanguageSupported(filename: string): boolean {
  return getParserForFile(filename) !== null;
}

export function highlightCode(code: string, filename: string): HighlightToken[][] {
  const steps = highlightCodeInSteps(code, filename);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Parser steps per unit of work: one step shifts or reduces a token. */
const PARSE_STEPS_PER_UNIT = 200;
/** Lines highlighted per unit of work. */
const LINES_PER_UNIT = 200;

export interface HighlightStepsOptions {
  /**
   * Highlight this many lines first and yield every line, those highlighted and the rest plain,
   * before highlighting the whole file.
   */
  firstLines?: number;
}

/** One unit of work done (`undefined`), or every line with the first ones highlighted. */
export type HighlightStep = HighlightToken[][] | undefined;


/**
 * Highlights `code` one bounded unit of work per `next()`, returning the highlighted lines when
 * done. Drive it under a time budget so a large file does not block the thread.
 *
 * The parser reads the file from its start, so a large file takes a while before any line is
 * highlighted. With `firstLines`, it first parses only as far as those lines and yields them.
 */
export function* highlightCodeInSteps(
  code: string,
  filename: string,
  options: HighlightStepsOptions = {},
): Generator<HighlightStep, HighlightToken[][], void> {
  const lines = code.split("\n");
  const parser = getParserForFile(filename);
  if (!parser) return lines.map(plainLine);

  const firstLines = options.firstLines ?? 0;
  // Highlighting the first lines first costs their parse twice; it pays only for a small share.
  if (firstLines > 0 && firstLines < lines.length / 2) {
    const firstTree = yield* parseInSteps(parser, code, lineOffset(lines, firstLines));
    const first = yield* highlightLinesInSteps(code, lines, firstTree, firstLines);
    yield [...first, ...lines.slice(firstLines).map(plainLine)];
  }
  const tree = yield* parseInSteps(parser, code);
  return yield* highlightLinesInSteps(code, lines, tree, lines.length);
}

function* parseInSteps(
  parser: Parser,
  code: string,
  stopAt?: number,
): Generator<undefined, Tree, void> {
  const parse = parser.startParse(code);
  if (stopAt !== undefined) parse.stopAt(stopAt);
  for (let step = 1; ; step++) {
    const tree = parse.advance();
    if (tree) return tree;
    if (step % PARSE_STEPS_PER_UNIT === 0) yield;
  }
}

/** Highlights the first `lineCount` lines of `code` from its parse `tree`. */
function* highlightLinesInSteps(
  code: string,
  lines: string[],
  tree: Tree,
  lineCount: number,
): Generator<undefined, HighlightToken[][], void> {
  const result: HighlightToken[][] = lines.slice(0, lineCount).map(() => []);
  const tokens = new LineTokenWriter(code, lines, result);
  let chunkFrom = 0;
  for (let first = 0; first < lineCount; first += LINES_PER_UNIT) {
    const last = Math.min(first + LINES_PER_UNIT, lineCount);
    let chunkTo = chunkFrom;
    for (let line = first; line < last; line++) chunkTo += lines[line].length + 1;
    chunkTo = Math.min(chunkTo, code.length);

    let cursor = chunkFrom;
    highlightTree(
      tree,
      staticSyntaxHighlighter,
      (from, to, classes) => {
        tokens.write(cursor, from, null);
        tokens.write(from, to, classes as HighlightStyle);
        cursor = to;
      },
      chunkFrom,
      chunkTo,
    );
    tokens.write(cursor, chunkTo, null);
    chunkFrom = chunkTo;
    yield;
  }

  for (const line of result) {
    if (line.length === 0) line.push({ text: "", style: null });
  }
  return result;
}

/** The offset where line `lineIndex` starts: past each earlier line and its newline. */
function lineOffset(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let line = 0; line < lineIndex; line++) offset += lines[line].length + 1;
  return offset;
}

function plainLine(line: string): HighlightToken[] {
  return [{ text: line, style: null }];
}

/** Splits styled ranges of the code into per-line tokens, written in order. */
class LineTokenWriter {
  private line = 0;
  private lineFrom = 0;

  constructor(
    private readonly code: string,
    private readonly lines: string[],
    private readonly result: HighlightToken[][],
  ) {}

  write(from: number, to: number, style: HighlightStyle | null): void {
    while (from < to) {
      let lineEnd = this.lineFrom + this.lines[this.line].length;
      while (from > lineEnd) {
        this.line++;
        this.lineFrom = lineEnd + 1;
        lineEnd = this.lineFrom + this.lines[this.line].length;
      }
      const end = Math.min(to, lineEnd);
      if (end > from) this.append(this.code.slice(from, end), style);
      from = end === lineEnd ? lineEnd + 1 : end;
    }
  }

  private append(text: string, style: HighlightStyle | null): void {
    const tokens = this.result[this.line];
    const last = tokens[tokens.length - 1];
    if (last && last.style === style) last.text += text;
    else tokens.push({ text, style });
  }
}

