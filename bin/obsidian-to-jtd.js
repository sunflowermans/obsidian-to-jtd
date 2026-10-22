#!/usr/bin/env node
import { main } from "../src/cli.js";

process.exit(main(process.argv.slice(2)));
