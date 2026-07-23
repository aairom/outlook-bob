#!/usr/bin/env node
/**
 * scan-partner-data.js
 *
 * Scans the data/ folder (relative to CWD) for partner sub-folders.
 * For each partner folder, lists files that have NOT yet been processed
 * (i.e. files that do NOT start with "ECOSYSTEM-AI-4-PROD" and are not
 * inside a "processed" sub-folder).
 *
 * Prints a JSON array to stdout:
 * [
 *   { "partner": "Partner 1", "folder": "data/Partner 1", "unprocessed": ["file.eml", ...] },
 *   ...
 * ]
 *
 * Exits with code 0 on success, 1 on fatal error (printed to stderr).
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(process.cwd(), "data");
const PROCESSED_PREFIX = "ECOSYSTEM-AI-4-PROD";
const PROCESSED_SUBDIR = "processed";
const EMAILS_SUBDIR = "AI-Emails-Suggestions";

if (!fs.existsSync(DATA_DIR)) {
  process.stderr.write(
    `ERROR: data/ folder not found at ${DATA_DIR}\n` +
    `Create data/<partner-name>/ and drop files there first.\n`
  );
  process.exit(1);
}

const partnerEntries = fs
  .readdirSync(DATA_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory());

const result = [];

for (const entry of partnerEntries) {
  const partnerFolder = path.join(DATA_DIR, entry.name);
  let files;
  try {
    files = fs.readdirSync(partnerFolder, { withFileTypes: true });
  } catch {
    // Skip folders we cannot read
    continue;
  }

  const unprocessed = files
    .filter(
      (f) =>
        f.isFile() &&
        !f.name.startsWith(PROCESSED_PREFIX) &&
        f.name !== PROCESSED_SUBDIR &&
        f.name !== EMAILS_SUBDIR
    )
    .map((f) => f.name);

  if (unprocessed.length > 0) {
    result.push({
      partner: entry.name,
      folder: path.relative(process.cwd(), partnerFolder).replace(/\\/g, "/"),
      unprocessed,
    });
  }
}

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
