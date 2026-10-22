# obsidian-to-jtd

Rewrites Obsidian wiki links into Markdown links for Just the Docs.

Heading fragments come from [`kramdown-gfm-anchors`](https://www.npmjs.com/package/kramdown-gfm-anchors), which matches the ids kramdown's GFM parser assigns. Jekyll uses that parser by default, and Just the Docs links to those ids.

```
[[#2. Overview]]         -> [2. Overview](#2-overview)
[[#4. Details|Details]]  -> [Details](#4-details)
[[Guide#Intro]]          -> [Intro](guide.html#intro)
![[diagram.png]]         -> ![diagram](diagram.png)
```

Links inside fenced code and inline code stay as written. A missing heading still becomes a link, and a warning is printed. Block references such as `[[#^block]]` are left unchanged.

Requires Node 20 or newer.

## Install

This package depends on `kramdown-gfm-anchors`.

```bash
npm install
```

## Use

```bash
npx obsidian-to-jtd notes.md -o notes-jtd.md
npx obsidian-to-jtd notes.md --in-place
npx obsidian-to-jtd --root ./vault notes.md
npx obsidian-to-jtd < notes.md > notes-jtd.md
```

`--root` is a directory of other notes. A link such as `[[Guide#Intro]]` reads `Guide.md` there, when it exists, so a repeated heading gets the same `-1` or `-2` suffix kramdown would assign. Without a readable note, the fragment is still generated from the heading text.

From code:

```js
import { convert } from "obsidian-to-jtd";

const { markdown, warnings } = convert("See [[#Overview]].\n\n# Overview\n");
```

`source` is the path of the file being converted. `root` is the same directory as `--root`.

```js
const { markdown, warnings } = convert(text, {
  source: "/path/to/notes.md",
  root: "/path/to/vault",
});
```

## Test

```bash
npm test
```
