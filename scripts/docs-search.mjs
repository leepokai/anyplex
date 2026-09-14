#!/usr/bin/env node
// Full-text search over the project docs and the vendor mirror, from the command line, so a
// session can ask "where do the docs mention stream_unavailable" without opening a browser.
// Every heading section of every Markdown file is one document; results are file:line.
//   pnpm docs:search "session budget"            top 10 across everything
//   pnpm docs:search --vendor cursor "artifacts"  one vendor only
//   pnpm docs:search -n 20 "last_event_id"        more results
// Uses MiniSearch (fuzzy + prefix) and builds the index on the fly (~1 s for ~8 MB).

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import MiniSearch from "minisearch";

const ROOT = new URL("../", import.meta.url).pathname;
const SOURCES = ["README.md", "CHANGELOG.md", "docs", "vendor-docs"];

const args = process.argv.slice(2);
let limit = 10;
let vendor = null;
const terms = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "-n") limit = Number(args[++i]) || 10;
  else if (args[i] === "--vendor") vendor = args[++i];
  else terms.push(args[i]);
}
const query = terms.join(" ").trim();
if (!query) {
  console.error('usage: pnpm docs:search [--vendor <name>] [-n <count>] "<query>"');
  process.exit(2);
}

async function* markdownFiles(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      yield* markdownFiles(full);
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".yaml")) yield full;
  }
}

/** Split a file into heading sections; the front matter and code fences stay searchable text. */
function sections(file, text) {
  const out = [];
  const lines = text.split("\n");
  let heading = "(top)";
  let start = 1;
  let buffer = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) out.push({ id: `${file}:${start}`, file, line: start, heading, text: body });
    buffer = [];
  };
  lines.forEach((line, index) => {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) {
      flush();
      heading = match[1].trim();
      start = index + 1;
      buffer.push(line);
    } else buffer.push(line);
  });
  flush();
  return out;
}

/** A YAML spec (the Cursor OpenAPI file) splits on its top-level and schema keys. */
function yamlSections(file, text) {
  const out = [];
  const lines = text.split("\n");
  let heading = "(top)";
  let start = 1;
  let buffer = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) out.push({ id: `${file}:${start}`, file, line: start, heading, text: body });
    buffer = [];
  };
  lines.forEach((line, index) => {
    const match = line.match(/^ {0,4}([A-Za-z_][\w./{}-]*):\s*$/);
    if (match && buffer.length > 8) {
      flush();
      heading = match[1];
      start = index + 1;
    }
    buffer.push(line);
  });
  flush();
  return out;
}

const docs = [];
for (const source of SOURCES) {
  const path = join(ROOT, source);
  const files = source.endsWith(".md") ? [path] : markdownFiles(path);
  for await (const file of files) {
    const rel = relative(ROOT, file);
    if (vendor && !rel.startsWith(`vendor-docs/${vendor}/`)) continue;
    const text = await readFile(file, "utf8");
    docs.push(...(rel.endsWith(".yaml") ? yamlSections(rel, text) : sections(rel, text)));
  }
}

// Identifiers such as `stream_unavailable` or `session.usage` stay one token.
const tokenize = (text) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.\-/]+/u)
    .map((token) => token.replace(/^[._\-/]+|[._\-/]+$/g, ""))
    .filter(Boolean);
const index = new MiniSearch({
  fields: ["heading", "text"],
  storeFields: ["file", "line", "heading", "text"],
  tokenize,
  searchOptions: { boost: { heading: 2 }, prefix: true, fuzzy: 0.1, combineWith: "AND" },
});
index.addAll(docs);
// Sections that contain the query verbatim outrank fuzzy and prefix matches.
const exact = query.toLowerCase();
const all = index
  .search(query)
  .sort(
    (a, b) =>
      Number(b.text.toLowerCase().includes(exact)) - Number(a.text.toLowerCase().includes(exact)) ||
      b.score - a.score,
  );
const hits = all.slice(0, limit);
if (!hits.length) {
  console.log(`no match for ${JSON.stringify(query)} in ${docs.length} sections`);
  process.exit(1);
}
const needle = query.toLowerCase().split(/\s+/)[0];
for (const hit of hits) {
  const lines = hit.text.split("\n");
  const at = Math.max(
    0,
    lines.findIndex((line) => line.toLowerCase().includes(needle)),
  );
  const snippet = lines[at]?.trim().slice(0, 160) ?? "";
  console.log(`${hit.file}:${hit.line}  ${hit.heading}`);
  console.log(`    ${snippet}`);
}
console.log(`\n${hits.length} of ${all.length} matches in ${docs.length} sections`);
