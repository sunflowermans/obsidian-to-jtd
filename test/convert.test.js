import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { convert } from "../src/convert.js";

const SAMPLE = `---
title: Sample
---

## 2. Overview

See [[#2. Overview]] and [[#4. Details|Details]].

## 4. Details

\`[[#2. Overview]]\` stays.

\`\`\`
[[#2. Overview]]
\`\`\`

## Section

## Section {#custom-section}

## Section

[[#Section]] [[#Missing]]
[[Other Page#Topic]]
`;

test("rewrites wiki links and leaves code alone", () => {
  const { markdown, warnings } = convert(SAMPLE);
  for (const bit of [
    "See [2. Overview](#2-overview) and [Details](#4-details).",
    "`[[#2. Overview]]` stays.",
    "```\n[[#2. Overview]]\n```",
    "[Section](#section)",
    "[Missing](#missing)",
    "[Topic](other-page.html#topic)",
    "title: Sample",
  ]) {
    assert.ok(markdown.includes(bit), `missing ${bit}`);
  }
  assert.equal(markdown.includes("[Section](#custom-section)"), false);
  assert.ok(warnings.some((warning) => warning.includes("Missing")));
});

test("image embeds become markdown images", () => {
  const { markdown } = convert("![[diagram.png]]\n");
  assert.equal(markdown, "![diagram](diagram.png)\n");
});

test("block references stay wiki links", () => {
  const { markdown, warnings } = convert("See [[#^block]].\n");
  assert.equal(markdown, "See [[#^block]].\n");
  assert.equal(warnings.length, 1);
});

test("a heading in another note supplies the fragment", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "obsidian-to-jtd-"));
  try {
    writeFileSync(path.join(dir, "guide.md"), "# Intro\n\n# Intro\n");
    const source = path.join(dir, "notes.md");
    const { markdown } = convert("See [[Guide#Intro]].\n", { source, root: dir });
    assert.equal(markdown, "See [Intro](guide.html#intro).\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli writes a file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "obsidian-to-jtd-"));
  const input = path.join(dir, "notes.md");
  const output = path.join(dir, "notes-jtd.md");
  writeFileSync(input, "See [[#Overview]].\n\n# Overview\n");
  const { main } = await import("../src/cli.js");
  assert.equal(main([input, "-o", output]), 0);
  assert.equal(readFileSync(output, "utf8"), "See [Overview](#overview).\n\n# Overview\n");
  rmSync(dir, { recursive: true, force: true });
});
