/**
 * Rewrite Obsidian wiki links to Markdown links whose fragments come from
 * `kramdown-gfm-anchors`.
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

const WIKILINK = /(?<!\\)(!?)\[\[([^\[\]]+)\]\]/g;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

const noteCache = new Map();

function countNewlines(text) {
  return text.match(/\n/g)?.length ?? 0;
}

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
  flush(inCode);
  return chunks;
}

function splitTarget(inner) {
  const match = /(?<!\\)\|/.exec(inner);
  if (!match) return [inner.replaceAll("\\|", "|").trim(), null];
  const target = inner.slice(0, match.index).replaceAll("\\|", "|").trim();
  const alias = inner.slice(match.index + 1).replaceAll("\\|", "|").trim();
  return [target, alias || null];
}

function splitPageHeading(target) {
  if (target.startsWith("#")) return ["", target.slice(1)];
  const hash = target.indexOf("#");
  if (hash !== -1) return [target.slice(0, hash).trim(), target.slice(hash + 1).trim()];
  return [target, null];
}

function escapeLabel(text) {
  return text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function formatDestination(destination) {
  return /[\s()]/.test(destination) ? `<${destination}>` : destination;
}

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

function fileStem(file) {
  const base = path.basename(file);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

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
        // missing candidate
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

function noteIndex(file) {
  const resolved = path.resolve(file);
  if (!noteCache.has(resolved)) {
    const { body } = splitFrontMatter(readFileSync(file, "utf8"));
    noteCache.set(resolved, indexHeadings(headingAnchors(body)));
  }
  return noteCache.get(resolved);
}

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

function unmask(text, masks) {
  let result = text;
  masks.forEach((original, number) => {
    result = result.replaceAll(`\ue000${number}\ue001`, original);
  });
  return result;
}

function replaceWikilinks(text, index, warnings, source, root, lineBase) {
  WIKILINK.lastIndex = 0;
  return text.replace(WIKILINK, (match, bang, inner, offset) => {
    const line = lineBase + countNewlines(text.slice(0, offset));
    const [target, alias] = splitTarget(inner);
    if (target.startsWith("^") || target.includes("#^")) {
      warnings.push(`line ${line}: left block reference [[${inner}]] unchanged`);
      return match;
    }
    const [page, heading] = splitPageHeading(target);
    if (bang === "!" && !heading) {
      const suffix = path.extname(page).toLowerCase();
      if (IMAGE_EXTENSIONS.has(suffix)) {
        const label = alias || fileStem(page);
        return `![${escapeLabel(label)}](${formatDestination(page)})`;
      }
    }
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
        if (labelSource == null && !page) labelSource = headingPlainText(found.text);
      } else {
        anchor = anchorForHeadingText(heading);
        const where = page ? ` in ${page}` : "";
        warnings.push(`line ${line}: no heading matches ${JSON.stringify(heading)}${where}; using #${anchor}`);
      }
    }
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
 * @param {string} text
 * @param {{ source?: string, root?: string }} [options]
 * @returns {{ markdown: string, warnings: string[] }}
 */
export function convert(text, { source = null, root = null } = {}) {
  const { front, body } = splitFrontMatter(text);
  const warnings = [];
  const index = indexHeadings(headingAnchors(body));
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
