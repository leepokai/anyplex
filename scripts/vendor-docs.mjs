#!/usr/bin/env node
// Mirror the vendors' managed-agent documentation into vendor-docs/ (ignored by git).
// Each vendor publishes an llms.txt index whose entries have Markdown twins; the pages whose
// URL matches the include patterns are fetched verbatim and written under the vendor folder
// with the path taken from the URL, plus front matter (source, fetched_at, sha256). See
// docs/vendor-docs.md. Node >= 22, no dependencies.
//   pnpm docs:vendor            refresh every vendor
//   pnpm docs:vendor cursor     refresh one vendor

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = new URL("../vendor-docs/", import.meta.url).pathname;
const CONCURRENCY = 4;

/** @type {Record<string, { indexes: string[]; include: RegExp[]; exclude?: RegExp[]; strip: RegExp; extra?: string[]; markdownUrl?: (url: string) => string }>} */
const SOURCES = {
  anthropic: {
    indexes: ["https://platform.claude.com/llms.txt"],
    include: [
      /\/docs\/en\/managed-agents\//,
      /\/docs\/en\/api\/beta\/(agents|sessions|environments|vaults|files|user_profiles)/,
      /\/docs\/en\/build-with-claude\/files\.md/,
    ],
    strip: /^\/docs\/en\//,
  },
  openai: {
    indexes: [
      "https://developers.openai.com/api/docs/llms.txt",
      "https://developers.openai.com/api/reference/llms.txt",
    ],
    // The Agents API guides live under guides/agents-api; guides/agents/* is the Agents SDK.
    include: [
      /\/api\/docs\/guides\/agents-api/,
      /\/api\/reference\/resources\/beta\/subresources\/agents/,
    ],
    strip: /^\/api\//,
    markdownUrl: (url) => (url.endsWith(".md") ? url : `${url}.md`),
  },
  google: {
    indexes: [
      "https://ai.google.dev/gemini-api/docs/llms.txt",
      "https://ai.google.dev/api/llms.txt",
    ],
    include: [
      /\/gemini-api\/docs\/(agent-environment|agents|antigravity-agent|custom-agents|managed-agents-quickstart|interactions-overview|interactions-breaking-changes-may-2026|streaming|background-execution|agent-hooks|get-started|migrate-to-interactions|files|function-calling|flex-inference)\.md/,
      /\/gemini-api\/docs\/models\/antigravity-preview/,
      /\/api\/(interactions|interactions-api|interactions-api-v1|interactions-v1|agents|environments)\.md/,
    ],
    strip: /^\/(gemini-api\/)?/,
    // The index links `.md.txt` twins; some entries carry the suffix twice.
    markdownUrl: (url) => url.replace(/(\.md\.txt)+$/, ".md.txt").replace(/\.md$/, ".md.txt"),
  },
  cursor: {
    indexes: ["https://cursor.com/llms.txt"],
    include: [/\/docs\/cloud-agent/, /\/docs\/api\.md/, /\/docs\/sdk\//],
    strip: /^\/docs\//,
    extra: ["https://cursor.com/docs-static/cloud-agents-openapi.yaml"],
    // cursor.com answers 404 to `.md` URLs from Node's fetch (curl gets them); the plain path
    // with `Accept: text/markdown` serves the same Markdown.
    markdownUrl: (url) => url.replace(/\.md$/, ""),
  },
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function fetchText(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "text/markdown, text/plain, */*" } });
      if (response.ok) return await response.text();
      if (response.status === 404 || response.status === 410) return null;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return null;
}

/** URLs in an llms.txt: markdown links and bare links, anchors stripped, deduped. */
function urlsIn(index) {
  const out = new Set();
  for (const match of index.matchAll(/https?:\/\/[^\s)<>"]+/g)) {
    let url = match[0].replace(/[),.]+$/, "");
    url = url.split("#")[0];
    out.add(url);
  }
  return [...out];
}

function localPath(vendor, url, spec) {
  const path = new URL(url).pathname
    .replace(spec.strip, "")
    .replace(/(\.md\.txt)+$/, ".md")
    .replace(/\.txt$/, ".txt");
  const file =
    path.endsWith(".md") || path.endsWith(".yaml") || path.endsWith(".txt") ? path : `${path}.md`;
  return join(ROOT, vendor, file.replace(/^\/+/, ""));
}

function titleOf(text, fallback) {
  const heading = text.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : fallback;
}

async function mirror(vendor, spec) {
  const fetchedAt = new Date().toISOString();
  const seen = new Set();
  const pages = [];
  for (const indexUrl of spec.indexes) {
    const index = await fetchText(indexUrl);
    if (index === null) {
      console.error(`${vendor}: index ${indexUrl} unreachable`);
      continue;
    }
    await mkdir(join(ROOT, vendor), { recursive: true });
    await writeFile(
      join(ROOT, vendor, `llms${spec.indexes.length > 1 ? `-${seen.size ? "b" : "a"}` : ""}.txt`),
      index,
    );
    for (const raw of urlsIn(index)) {
      const url = spec.markdownUrl ? spec.markdownUrl(raw) : raw;
      const path = new URL(url).pathname;
      if (!spec.include.some((re) => re.test(path))) continue;
      if (spec.exclude?.some((re) => re.test(path))) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      pages.push(url);
    }
  }
  for (const url of spec.extra ?? []) if (!seen.has(url)) pages.push(url);

  const rows = [];
  const missing = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < pages.length) {
        const url = pages[cursor++];
        const text = await fetchText(url);
        if (text === null || text.trim().length === 0) {
          missing.push(url);
          continue;
        }
        const file = localPath(vendor, url, spec);
        await mkdir(dirname(file), { recursive: true });
        const isMarkdown = file.endsWith(".md");
        const body = isMarkdown
          ? `---\nsource: ${url}\nfetched_at: ${fetchedAt}\nsha256: ${sha256(text)}\n---\n\n${text}`
          : text;
        await writeFile(file, body);
        rows.push({
          file: file.slice(join(ROOT, vendor).length + 1),
          title: titleOf(text, url),
          url,
          bytes: text.length,
        });
      }
    }),
  );
  rows.sort((a, b) => a.file.localeCompare(b.file));
  const index = [
    `# ${vendor}: documentation mirror`,
    "",
    `Fetched ${fetchedAt} from ${spec.indexes.join(", ")}. ${rows.length} pages.`,
    "",
    "| File | Title | Source | Size |",
    "|---|---|---|---|",
    ...rows.map(
      (r) => `| \`${r.file}\` | ${r.title.replace(/\|/g, "\\|")} | ${r.url} | ${r.bytes} |`,
    ),
    ...(missing.length ? ["", "## Missing", "", ...missing.map((url) => `- ${url}`)] : []),
    "",
  ].join("\n");
  await writeFile(join(ROOT, vendor, "INDEX.md"), index);
  console.log(`${vendor}: ${rows.length} pages, ${missing.length} missing`);
  return { vendor, pages: rows.length, missing: missing.length, fetchedAt };
}

const only = process.argv.slice(2);
const results = [];
for (const [vendor, spec] of Object.entries(SOURCES)) {
  if (only.length && !only.includes(vendor)) continue;
  results.push(await mirror(vendor, spec));
}
// The summary merges with the last full run so a partial refresh keeps the other rows.
const manifestFile = join(ROOT, "manifest.json");
const manifest = JSON.parse(await readFile(manifestFile, "utf8").catch(() => "{}"));
for (const r of results) manifest[r.vendor] = r;
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
const rows = Object.values(manifest).sort((a, b) => a.vendor.localeCompare(b.vendor));
const readme = [
  "# Vendor documentation mirror",
  "",
  "Fetched by `pnpm docs:vendor` (`scripts/vendor-docs.mjs`); see `docs/vendor-docs.md`. Ignored by git.",
  "The pages are the vendors' documentation and copyright; this copy exists so provider work reads",
  "the complete text locally. Start at each vendor's `INDEX.md`.",
  "",
  "| Vendor | Pages | Missing | Fetched |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.vendor} | ${r.pages} | ${r.missing} | ${r.fetchedAt} |`),
  "",
  "Browse with `pnpm docs:dev` (VitePress, local search) or query from the shell with",
  '`pnpm docs:search "<terms>"`.',
  "",
].join("\n");
await writeFile(join(ROOT, "README.md"), readme);
