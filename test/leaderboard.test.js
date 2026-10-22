import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPyodide } from 'pyodide';

import { runEpisode, aggregate, LEADERBOARD } from '../src/sim/runner.js';
import { initPython } from '../src/sim/python.js';
import { EXAMPLES } from '../src/examples.js';
import { score, leaderboardRuns } from '../leaderboard/score.mjs';
import { codeFromIssue } from '../leaderboard/extract.mjs';
import { applyResult, comment } from '../leaderboard/publish.mjs';

const prelude = readFileSync(new URL('../src/sim/prelude.py', import.meta.url), 'utf8');
const starter = EXAMPLES.find((e) => e.id === 'starter').code;

test('path RMSE: perfect line is 0, a car that never moves scores the off-track distance', () => {
  const still = runEpisode({ controller: { begin() {}, setup() {}, loop() {} }, carSeed: 1, trackLength: 2, record: false });
  assert.equal(still.result.pathRmseCm, still.result.task.offTrack * 100);
  const agg = aggregate([{ pathRmseCm: 3, scoreCm: 4, finished: true }, { pathRmseCm: 4, scoreCm: 3, finished: false }]);
  assert.equal(agg.pathRmseCm, Math.sqrt(12.5));
  assert.equal(agg.finished, 1);
});

test('the sandbox protocol gives exactly the browser result', async () => {
  const py = await initPython(loadPyodide, {}, prelude);
  const runs = [
    { carSeed: 5, runSeed: 9 },
    { carSeed: 12, runSeed: 3 },
  ];
  const piped = await score(starter, runs, { local: true });
  assert.equal(piped.ok, true, piped.error);
  runs.forEach((r, i) => {
    const { result } = runEpisode({ controller: py.controller(starter), ...r, ...LEADERBOARD, record: false });
    assert.equal(piped.perRun[i].pathRmseCm, Math.round(result.pathRmseCm * 1000) / 1000);
  });
});

test('the sandbox reports errors, blocked imports and hangs instead of crashing', async () => {
  const one = [{ carSeed: 2, runSeed: 2 }];
  const blocked = await score('import js\ndef loop():\n    pass\n', one, { local: true });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /js is not available/);
  const hang = await score('def loop():\n    while True:\n        pass\n', one, { local: true });
  assert.match(hang.error, /did not answer/);
  const exit = await score('import os\ndef loop():\n    os._exit(3)\n', one, { local: true });
  assert.match(exit.error, /stopped unexpectedly/);
});

test('hidden runs come from the secret', () => {
  const a = leaderboardRuns('secret-a', 30);
  assert.equal(a.length, 30);
  assert.deepEqual(a, leaderboardRuns('secret-a', 30));
  assert.notDeepEqual(a, leaderboardRuns('secret-b', 30));
  assert.ok(a.every((r) => r.carSeed > 20), 'never the public benchmark cars');
});

test('code is read from the issue form', () => {
  const body = '### controller.py\n\n```python\ndef loop():\n    motors.set(0.5, 0.5)\n```\n';
  assert.equal(codeFromIssue(body), 'def loop():\n    motors.set(0.5, 0.5)\n');
  assert.equal(codeFromIssue('### controller.py\n\n_No response_'), null);
  assert.equal(codeFromIssue('```\r\ndef loop():\r\n    pass\r\n```'), 'def loop():\n    pass\n');
});

test('each user keeps their best entry, sorted by path RMSE', () => {
  const res = (path, fin = 1) => ({ ok: true, pathRmseCm: path, finishRmseCm: fin, finished: 30, runs: 30, rules: LEADERBOARD, codeSha256: 'x' });
  const who = (user, at) => ({ user, avatar: '', issue: 'https://github.com/o/r/issues/1', submittedAt: at });
  let board = { entries: [] };
  assert.equal(applyResult(board, res(10), who('ann', '2026-01-01')).outcome, 'accepted');
  assert.equal(applyResult(board, res(5), who('bob', '2026-01-02')).outcome, 'accepted');
  assert.equal(applyResult(board, res(12), who('Ann', '2026-01-03')).outcome, 'kept');
  assert.equal(applyResult(board, res(4), who('ann', '2026-01-04')).outcome, 'improved');
  assert.equal(applyResult(board, { ok: false, error: 'x' }, who('cat', '2026-01-05')).outcome, 'rejected');
  assert.deepEqual(board.entries.map((e) => [e.user, e.pathRmseCm]), [['ann', 4], ['bob', 5]]);
  assert.match(comment(res(4), 'improved', board, who('ann'), 'https://site/'), /#1/);
  assert.match(comment(null, 'rejected', board, who('cat'), ''), /did not complete/);
});
