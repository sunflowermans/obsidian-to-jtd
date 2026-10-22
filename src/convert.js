/**
 * Rewrite Obsidian wiki links to Markdown links whose fragments come from
 * `kramdown-gfm-anchors`.
 *
 * Pipeline for one note:
 * 1. Split YAML front matter off so it is copied through unchanged.
 * 2. Index headings in the body so same-page links get kramdown's anchor ids,
 *    including `-1` / `-2` suffixes when a heading text repeats.
 * 3. Split the body into fenced code blocks and everything else. Fenced code
 *    is copied through so example wiki links stay literal.
 * 4. Inside prose, hide inline code spans, rewrite `[[...]]` links, then put
 *    the code spans back.
 * 5. Return the rewritten markdown plus warnings for links that could not be
 *    resolved exactly (missing headings, block references).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  anchorForHeadingText,
  findHeading,
  headingAnchors,
  headingPlainText,
  indexHeadings,
  splitFrontMatter,
} from "kramdown-gfm-anchors";

// Obsidian wiki link: optional embed bang, then [[target]] or [[target|alias]].
// A leading backslash (`\[[`) is an escaped link and is left alone.
// Capture groups: (1) "!" or "", (2) the inside of the brackets.
const WIKILINK = /(?<!\\)(!?)\[\[([^\[\]]+)\]\]/g;

// Extensions that `![[file.ext]]` should become a Markdown image for.
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

// Heading indexes for notes already read while resolving cross-note links.
// Keyed by absolute path so the same note is parsed only once per process.
const noteCache = new Map();

/** How many newline characters `text` contains. Used to keep warning line numbers accurate. */
function countNewlines(text) {
  return text.match(/\n/g)?.length ?? 0;
}

/**
 * Split `text` into lines without dropping the newline that ended each line.
 * The last line is included even when the text does not end with `\n`.
 */
function splitLinesKeep(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * Split markdown into alternating prose and fenced-code chunks.
 * Each chunk is `[isCode, text]`. A fence is three or more backticks or
 * tildes, indented at most three spaces (CommonMark). The closing fence must
 * use the same character and be at least as long as the opener.
 */
function splitFencedBlocks(text) {
  const chunks = [];
  let buffer = "";
  let inCode = false;
  let fenceChar = "";
  let fenceLen = 0;
  const flush = (isCode) => {
    if (buffer) {
      chunks.push([isCode, buffer]);
      buffer = "";
    }
  };
  for (const line of splitLinesKeep(text)) {
    if (!inCode) {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (match) {
        // Start a new code chunk at the opening fence line.
        flush(false);
        inCode = true;
        fenceChar = match[1][0];
        fenceLen = match[1].length;
      }
      buffer += line;
    } else {
      buffer += line;
      const closer = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}[ \\t]*\\r?\\n?$`);
      if (closer.test(line)) {
        flush(true);
        inCode = false;
      }
    }
  }
  // An unclosed fence is still treated as code so its wiki links are not rewritten.
  flush(inCode);
  return chunks;
}

/**
 * Split the inside of `[[...]]` into a link target and an optional display alias.
 * The separator is the first unescaped `|`. `\|` inside either side is a literal pipe.
 * Returns `[target, alias]`; `alias` is null when there is no `|`.
 */
function splitTarget(inner) {
  const match = /(?<!\\)\|/.exec(inner);
  if (!match) return [inner.replaceAll("\\|", "|").trim(), null];
  const target = inner.slice(0, match.index).replaceAll("\\|", "|").trim();
  const alias = inner.slice(match.index + 1).replaceAll("\\|", "|").trim();
  return [target, alias || null];
}

/**
 * Split a wiki target into a note name and a heading.
 * `Page#Heading` -> `["Page", "Heading"]`
 * `#Heading`     -> `["", "Heading"]` (same note)
 * `Page`         -> `["Page", null]`
 */
function splitPageHeading(target) {
  if (target.startsWith("#")) return ["", target.slice(1)];
  const hash = target.indexOf("#");
  if (hash !== -1) return [target.slice(0, hash).trim(), target.slice(hash + 1).trim()];
  return [target, null];
}

/** Escape characters that would break a Markdown link label. */
function escapeLabel(text) {
  return text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

/**
 * Wrap a link destination in `<...>` when it contains spaces or parentheses,
 * which are otherwise ambiguous in a Markdown link.
 */
function formatDestination(destination) {
  return /[\s()]/.test(destination) ? `<${destination}>` : destination;
}

/**
 * Turn an Obsidian note name into the `.html` path Just the Docs / Jekyll
 * would publish. Each path segment is slugified the same way a heading is,
 * so `My Note` becomes `my-note`. A trailing `.md` is dropped.
 */
function pageSlug(page) {
  let value = page.trim();
  if (value.toLowerCase().endsWith(".md")) value = value.slice(0, -3);
  const segments = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    segments.push(anchorForHeadingText(segment) || segment);
  }
  return segments.join("/");
}

/** File name without its extension. `diagram.png` -> `diagram`. */
function fileStem(file) {
  const base = path.basename(file);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

/** Recursively collect `.md` files under `dir`, skipping `node_modules` and `.git`. */
function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * Resolve a wiki page name to a markdown file on disk.
 * Search order:
 * 1. Next to the source note: `Page.md`, then `Page/index.md`.
 * 2. Under `root` with the same two layouts.
 * 3. If the name has no slash, a single case-insensitive stem match anywhere
 *    under `root` (Obsidian's shortest-path style). Ambiguous matches are ignored.
 * Returns the file path, or null when nothing unique is found.
 */
function findNote(page, source, root) {
  let relative = page.trim();
  if (relative.toLowerCase().endsWith(".md")) relative = relative.slice(0, -3);
  relative = relative.replaceAll("\\", "/");
  const bases = [];
  if (source) bases.push(path.dirname(source));
  if (root) bases.push(root);
  const seen = new Set();
  for (const base of bases) {
    for (const candidate of [path.join(base, `${relative}.md`), path.join(base, relative, "index.md")]) {
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Candidate does not exist; try the next location.
      }
    }
    if (root && path.resolve(base) === path.resolve(root) && !relative.includes("/")) {
      const matches = walkMarkdown(root).filter(
        (file) => fileStem(file).toLowerCase() === path.basename(relative).toLowerCase(),
      );
      if (matches.length === 1) return matches[0];
    }
  }
  return null;
}

/**
 * Heading index for another note, cached by absolute path.
 * Front matter is stripped before headings are collected so a `title:` line
 * is not treated as a heading.
 */
function noteIndex(file) {
  const resolved = path.resolve(file);
  if (!noteCache.has(resolved)) {
    const { body } = splitFrontMatter(readFileSync(file, "utf8"));
    noteCache.set(resolved, indexHeadings(headingAnchors(body)));
  }
  return noteCache.get(resolved);
}

/**
 * Replace inline code spans with private-use placeholders so wiki links
 * inside backticks are not rewritten. Returns `[maskedText, originals]`.
 * A span is an unescaped run of backticks and a later matching run.
 */
function maskInlineCode(text) {
  const masks = [];
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "`" && (index === 0 || text[index - 1] !== "\\")) {
      let end = index;
      while (end < text.length && text[end] === "`") end += 1;
      const ticks = text.slice(index, end);
      const close = text.indexOf(ticks, end);
      if (close !== -1) {
        const token = `\ue000${masks.length}\ue001`;
        masks.push(text.slice(index, close + ticks.length));
        result += token;
        index = close + ticks.length;
        continue;
      }
    }
    result += text[index];
    index += 1;
  }
  return [result, masks];
}

/** Put the original inline code spans back in place of the placeholders. */
function unmask(text, masks) {
  let result = text;
  masks.forEach((original, number) => {
    result = result.replaceAll(`\ue000${number}\ue001`, original);
  });
  return result;
}

/**
 * Rewrite every wiki link in a prose chunk.
 * `index` is the heading index of the note being converted.
 * `lineBase` is the 1-based line number where this chunk starts, so warnings
 * point at the original file.
 */
function replaceWikilinks(text, index, warnings, source, root, lineBase) {
  WIKILINK.lastIndex = 0;
  return text.replace(WIKILINK, (match, bang, inner, offset) => {
    const line = lineBase + countNewlines(text.slice(0, offset));
    const [target, alias] = splitTarget(inner);

    // Block references (`[[^id]]`, `[[#^id]]`) have no kramdown heading id.
    if (target.startsWith("^") || target.includes("#^")) {
      warnings.push(`line ${line}: left block reference [[${inner}]] unchanged`);
      return match;
    }

    const [page, heading] = splitPageHeading(target);

    // `![[diagram.png]]` is an embed. Image files become Markdown images;
    // other embeds fall through and are treated as ordinary links.
    if (bang === "!" && !heading) {
      const suffix = path.extname(page).toLowerCase();
      if (IMAGE_EXTENSIONS.has(suffix)) {
        const label = alias || fileStem(page);
        return `![${escapeLabel(label)}](${formatDestination(page)})`;
      }
    }

    // Resolve the heading fragment. Same-page links use this note's index.
    // `Page#Heading` loads that note (when it can be found) so repeated
    // headings pick up the same `-1` / `-2` suffix kramdown would assign.
    let anchor = "";
    let labelSource = alias;
    if (heading) {
      let headingIndex = index;
      if (page) {
        const note = findNote(page, source, root);
        headingIndex = note ? noteIndex(note) : new Map();
      }
      const found = headingIndex.size ? findHeading(headingIndex, heading) : null;
      if (found) {
        anchor = found.anchor;
        // Same-page links with no alias use the heading's visible text,
        // which drops an explicit `{#custom-id}` from the label.
        if (labelSource == null && !page) labelSource = headingPlainText(found.text);
      } else {
        // Still emit a link. The fragment is the slug of the heading text,
        // which is what kramdown would use for a heading that existed.
        anchor = anchorForHeadingText(heading);
        const where = page ? ` in ${page}` : "";
        warnings.push(`line ${line}: no heading matches ${JSON.stringify(heading)}${where}; using #${anchor}`);
      }
    }

    // Label priority: explicit alias, then the heading text, then the page name.
    if (labelSource == null) labelSource = heading ? headingPlainText(heading) : page;

    let destination;
    if (page) {
      destination = `${pageSlug(page)}.html`;
      if (anchor) destination += `#${anchor}`;
      destination = formatDestination(destination);
    } else {
      destination = `#${anchor}`;
    }
    return `[${escapeLabel(labelSource)}](${destination})`;
  });
}

/**
 * Convert one note's markdown.
 * @param {string} text
 * @param {{ source?: string, root?: string }} [options]
 *   `source` is the path of the file being converted (used to find sibling notes).
 *   `root` is a vault directory searched when a linked note is not a sibling.
 * @returns {{ markdown: string, warnings: string[] }}
 */
export function convert(text, { source = null, root = null } = {}) {
  const { front, body } = splitFrontMatter(text);
  const warnings = [];
  const index = indexHeadings(headingAnchors(body));

  // Front matter occupies the lines before the body, so the first body line
  // is one past the number of newlines in `front`.
  let lineNo = countNewlines(front) + 1;
  let markdown = front;
  for (const [isCode, chunk] of splitFencedBlocks(body)) {
    if (isCode) {
      markdown += chunk;
    } else {
      const [masked, masks] = maskInlineCode(chunk);
      markdown += unmask(replaceWikilinks(masked, index, warnings, source, root, lineNo), masks);
    }
    lineNo += countNewlines(chunk);
  }
  return { markdown, warnings };
}
