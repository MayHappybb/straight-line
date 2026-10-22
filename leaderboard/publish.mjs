// Records a scored submission in leaderboard.json and writes the comment for the issue.
// Each GitHub user keeps their best entry; the list is sorted by path RMSE (lower is better).
//
// Environment: RESULT (score.mjs JSON, empty if scoring crashed), LB_USER, LB_AVATAR, LB_ISSUE_URL,
// LB_SUBMITTED_AT, LB_FILE (leaderboard.json path), LB_COMMENT (where to write the comment),
// LB_SITE (link back to the site).
// Prints "accepted", "improved", "kept" or "rejected".

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function applyResult(board, result, who) {
  board.entries ??= [];
  if (!result?.ok) return { board, outcome: 'rejected' };
  const entry = {
    user: who.user,
    avatar: who.avatar,
    pathRmseCm: result.pathRmseCm,
    finishRmseCm: result.finishRmseCm,
    finished: result.finished,
    runs: result.runs,
    issue: who.issue,
    submittedAt: who.submittedAt,
    codeSha256: result.codeSha256,
  };
  const i = board.entries.findIndex((e) => e.user.toLowerCase() === who.user.toLowerCase());
  let outcome = 'accepted';
  if (i >= 0) {
    if (better(entry, board.entries[i])) {
      board.entries[i] = entry;
      outcome = 'improved';
    } else {
      outcome = 'kept';
    }
  } else {
    board.entries.push(entry);
  }
  board.entries.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
  board.rules = result.rules;
  board.updatedAt = who.submittedAt;
  return { board, outcome };
}

/** Lower path RMSE wins; ties go to the lower finish RMSE, then the earlier entry. */
function better(a, b) {
  if (a.pathRmseCm !== b.pathRmseCm) return a.pathRmseCm < b.pathRmseCm;
  if (a.finishRmseCm !== b.finishRmseCm) return a.finishRmseCm < b.finishRmseCm;
  return a.submittedAt < b.submittedAt;
}

export function comment(result, outcome, board, who, site) {
  if (!result) {
    return `Scoring did not complete, so nothing was recorded. This is a problem on the leaderboard's side, not necessarily your code. Open a new submission to try again.`;
  }
  if (!result.ok) {
    return [
      result.runs
        ? `Your controller stopped with an error in all ${result.runs} runs, so it was not added to the leaderboard. The first error was:`
        : 'This submission could not be scored:',
      '',
      '```',
      String(result.error).slice(0, 1500),
      '```',
      '',
      'The leaderboard runs standard Python 3 with only the standard library. Try it in the simulator first, then open a new submission.',
    ].join('\n');
  }
  const rank = board.entries.findIndex((e) => e.user.toLowerCase() === who.user.toLowerCase()) + 1;
  const best = board.entries[rank - 1];
  const lines = [
    `**Path RMSE: ${result.pathRmseCm.toFixed(2)} cm** over ${result.runs} hidden cars on the ${result.rules.trackLength} m track (noise ${result.rules.noise}×).`,
    '',
    `| | |`,
    `|---|---|`,
    `| Finish RMSE | ${result.finishRmseCm.toFixed(2)} cm |`,
    `| Finished | ${result.finished} of ${result.runs} |`,
    result.errors ? `| Runs stopped by an error | ${result.errors} |` : null,
    `| Scored in | ${result.elapsedS} s |`,
    '',
    outcome === 'kept'
      ? `Your earlier entry is better (${best.pathRmseCm.toFixed(2)} cm), so it stays. You are **#${rank}**.`
      : `You are **#${rank}** of ${board.entries.length}.${outcome === 'improved' ? ' This replaces your earlier entry.' : ''}`,
    result.errors ? `\nSome runs stopped with an error, counted as off the track from there on:\n\n\`\`\`\n${String(result.firstError).slice(0, 800)}\n\`\`\`` : null,
    '',
    `The leaderboard on the site updates within a few minutes: ${site}`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const result = env.RESULT ? JSON.parse(env.RESULT) : null;
  const file = env.LB_FILE;
  const board = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { entries: [] };
  const who = { user: env.LB_USER, avatar: env.LB_AVATAR, issue: env.LB_ISSUE_URL, submittedAt: env.LB_SUBMITTED_AT };
  const { outcome } = applyResult(board, result, who);
  if (outcome !== 'rejected') writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`);
  writeFileSync(env.LB_COMMENT, comment(result, outcome, board, who, env.LB_SITE));
  console.log(result ? outcome : 'rejected');
}
