// VitePress site over the project docs and the vendor documentation mirror: sidebar built
// from the file tree and each vendor's INDEX.md, local full-text search, no dead-link checks
// (vendor pages link to their own sites). `pnpm docs:dev` to browse, `pnpm docs:build` to emit.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DefaultTheme, defineConfig } from "vitepress";

const repo = join(import.meta.dirname, "../..");
const vendorRoot = join(repo, "vendor-docs");

/** One collapsible group per top-level folder of a vendor mirror, items from its INDEX.md. */
function vendorSidebar(vendor: string): DefaultTheme.SidebarItem[] {
  const indexFile = join(vendorRoot, vendor, "INDEX.md");
  if (!existsSync(indexFile)) return [];
  const rows = readFileSync(indexFile, "utf8")
    .split("\n")
    .map((line) => line.match(/^\| `([^`]+)` \| (.+?) \| \S+ \| \d+ \|$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ file: m[1] as string, title: m[2] as string }))
    .filter((row) => row.file.endsWith(".md"));
  const groups = new Map<string, DefaultTheme.SidebarItem[]>();
  for (const row of rows) {
    const [head, ...rest] = row.file.split("/");
    const group = rest.length ? (head as string) : ".";
    const items = groups.get(group) ?? [];
    items.push({
      text: row.title,
      link: `/vendor-docs/${vendor}/${row.file.replace(/\.md$/, "")}`,
    });
    groups.set(group, items);
  }
  return [...groups.entries()].map(([group, items]) => ({
    text: group === "." ? "Pages" : group,
    collapsed: true,
    items: items.sort((a, b) => (a.text ?? "").localeCompare(b.text ?? "")),
  }));
}

const vendors = existsSync(vendorRoot)
  ? readdirSync(vendorRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

export default defineConfig({
  title: "anyplex",
  description: "LiteLLM for managed agents: one session interface for hosted agent runtimes.",
  srcDir: "..",
  srcExclude: [
    "node_modules/**",
    "dist/**",
    "src/**",
    "test/**",
    "examples/**",
    "scripts/**",
    "assets/**",
    ".github/**",
    "README.md",
    "vendor-docs/README.md",
    "vendor-docs/*/INDEX.md",
  ],
  rewrites: { "docs/:page*": ":page*" },
  ignoreDeadLinks: true,
  cleanUrls: true,
  lastUpdated: false,
  markdown: {
    // Vendor pages are arbitrary Markdown: raw HTML off so `<tool_name>` stays text, and the
    // whole page wrapped in `v-pre` so `{{ }}` anywhere (prose, tables, inline code) is left
    // alone by the Vue compiler.
    html: false,
    config(md) {
      md.core.ruler.push("anyplex_vendor_vpre", (state) => {
        const env = state.env as { path?: string; frontmatter?: { source?: string } };
        const path = String(env.path ?? "");
        if (!path.includes("/vendor-docs/")) return;
        // Images and site-relative links point back at the vendor's site; Vite would
        // otherwise try to bundle `/docs-static/...` as a local asset.
        const source = env.frontmatter?.source;
        if (source)
          for (const token of state.tokens)
            for (const child of token.children ?? [])
              for (const attr of ["src", "href"] as const) {
                const value = child.attrGet(attr);
                if (value && !/^[a-z]+:/i.test(value) && !value.startsWith("#"))
                  child.attrSet(attr, new URL(value, source).href);
              }
        const open = new state.Token("html_block", "", 0);
        open.content = "<div v-pre>\n";
        const close = new state.Token("html_block", "", 0);
        close.content = "</div>\n";
        state.tokens.unshift(open);
        state.tokens.push(close);
      });
    },
  },
  themeConfig: {
    logo: { light: "/icon.svg", dark: "/icon-dark.svg" },
    search: { provider: "local" },
    nav: [
      { text: "Project", link: "/architecture" },
      ...vendors.map((vendor) => ({ text: vendor, link: `/vendor-docs/${vendor}/` })),
      { text: "GitHub", link: "https://github.com/leepokai/anyplex" },
    ],
    sidebar: {
      "/": [
        {
          text: "anyplex",
          items: [
            { text: "Architecture", link: "/architecture" },
            { text: "Conventions", link: "/conventions" },
            { text: "File structure", link: "/file-structure" },
            { text: "Building a relay on top", link: "/gateway-readiness" },
            { text: "Vendor documentation mirror", link: "/vendor-docs" },
            { text: "Unmapped vendor features", link: "/vendor-gaps" },
            { text: "Changelog", link: "/CHANGELOG" },
          ],
        },
      ],
      ...Object.fromEntries(
        vendors.map((vendor) => [
          `/vendor-docs/${vendor}/`,
          [{ text: `${vendor} documentation (mirror)`, items: vendorSidebar(vendor) }],
        ]),
      ),
    },
  },
});
