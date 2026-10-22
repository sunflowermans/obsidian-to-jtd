import { readFileSync, writeFileSync } from "node:fs";
import { convert } from "./convert.js";

function printHelp() {
  console.log(`Convert Obsidian wiki links to Just the Docs (kramdown GFM) links.

Usage:
  obsidian-to-jtd notes.md -o notes-jtd.md
  obsidian-to-jtd notes.md --in-place
  obsidian-to-jtd --root ./vault notes.md
  obsidian-to-jtd < notes.md > notes-jtd.md
`);
}

/** Print an error and return the process exit code. */
function fail(message) {
  console.error(message);
  return 1;
}

/**
 * Convert one file. Warnings go to stderr, prefixed with the file path.
 * Output goes to `--output`, overwrites the input with `--in-place`, or
 * stdout when neither is set.
 */
function convertFile(file, { output, root, inPlace }) {
  const original = readFileSync(file, "utf8");
  const { markdown, warnings } = convert(original, { source: file, root });
  for (const warning of warnings) console.error(`${file}: ${warning}`);
  const destination = inPlace ? file : output;
  if (!destination) process.stdout.write(markdown);
  else writeFileSync(destination, markdown);
}

/**
 * Parse argv and run the conversion.
 * Flags: `-h`/`--help`, `--in-place`, `--root <dir>`, `-o`/`--output <file>`.
 * With no file arguments, markdown is read from stdin and written to stdout.
 * @param {string[]} [argv]
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  const files = [];
  let output = null;
  let inPlace = false;
  let root = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      return 0;
    }
    if (arg === "--in-place") {
      inPlace = true;
    } else if (arg === "--root") {
      root = argv[index + 1];
      if (!root) return fail("--root needs a directory");
      index += 1;
    } else if (arg === "-o" || arg === "--output") {
      output = argv[index + 1];
      if (!output) return fail("--output needs a file");
      index += 1;
    } else if (arg.startsWith("-")) {
      return fail(`unknown option ${arg}`);
    } else {
      files.push(arg);
    }
  }

  // `-o` names a single destination, so it only makes sense for one input
  // and conflicts with rewriting that input in place.
  if (output && (inPlace || files.length !== 1)) {
    return fail("--output is for a single input file and cannot be combined with --in-place");
  }
  if (inPlace && files.length === 0) return fail("--in-place needs at least one file");

  if (files.length === 0) {
    const original = readFileSync(0, "utf8");
    const { markdown, warnings } = convert(original, { root });
    for (const warning of warnings) console.error(warning);
    process.stdout.write(markdown);
    return 0;
  }

  for (const file of files) convertFile(file, { output, root, inPlace });
  return 0;
}
