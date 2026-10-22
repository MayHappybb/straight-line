// Pulls the controller code out of a leaderboard issue (or an example, for a dry run) and prints it.
//   ISSUE_BODY=...  node leaderboard/extract.mjs > controller.py
//   EXAMPLE=starter node leaderboard/extract.mjs > controller.py

import { fileURLToPath } from 'node:url';
import { EXAMPLES } from '../src/examples.js';

/** The issue form renders the code field as a ```python fenced block under its heading. */
export function codeFromIssue(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const open = text.search(/^```[ \t]*(python|py)?[ \t]*$/m);
  if (open < 0) return null;
  const start = text.indexOf('\n', open) + 1;
  const end = text.lastIndexOf('\n```');
  if (end < start) return null;
  const code = text.slice(start, end);
  return code.trim() ? `${code}\n` : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let code;
  if (process.env.EXAMPLE) {
    code = EXAMPLES.find((e) => e.id === process.env.EXAMPLE)?.code;
    if (!code) {
      console.error(`no example called ${process.env.EXAMPLE}`);
      process.exit(1);
    }
  } else {
    code = codeFromIssue(process.env.ISSUE_BODY);
    if (!code) {
      console.error('no ```python code block found in the issue');
      process.exit(1);
    }
  }
  process.stdout.write(code);
}
