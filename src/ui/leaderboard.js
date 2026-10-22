// The Leaderboard tab: shows leaderboard.json (built into the site by the Pages workflow) and
// opens a pre-filled GitHub issue to submit the current controller.

import { escapeHtml } from './charts.js';
import { LEADERBOARD } from '../sim/runner.js';

const MAX_URL = 7000; // GitHub rejects much longer issue URLs; longer code goes via the clipboard

/**
 * @param container  element to render into
 * @param repo       "owner/name" of the GitHub repository that scores submissions
 * @param getCode    () => current controller source
 * @param onTryRules () => run the Benchmark under the leaderboard rules
 * @param toast      (text) => void
 */
export function createLeaderboard({ container, repo, getCode, onTryRules, toast }) {
  let loaded = false;

  const rules = `${LEADERBOARD.runs} hidden cars on the ${LEADERBOARD.trackLength} m track, noise ${LEADERBOARD.noise}×`;

  function frame(body) {
    container.innerHTML = `
      <div class="lb-head">
        <p class="lb-rules">Ranked by path RMSE over ${rules}. Lower is better.</p>
        <div class="lb-actions">
          <button type="button" class="btn" data-try>Try these rules on cars 1 to 20</button>
          <button type="button" class="btn primary" data-submit>Submit controller.py</button>
        </div>
      </div>
      <p class="note lb-note">Submitting opens a GitHub issue with your code, so you need a GitHub account and the code is public. A bot runs it on cars nobody has seen and replies on the issue in a few minutes. Only your best entry counts.</p>
      ${body}`;
    container.querySelector('[data-submit]').addEventListener('click', submit);
    container.querySelector('[data-try]').addEventListener('click', onTryRules);
  }

  function render(board) {
    const entries = Array.isArray(board?.entries) ? board.entries : [];
    if (!entries.length) {
      frame('<p class="lb-empty">No entries yet. Submit yours to open the board.</p>');
      return;
    }
    const rows = entries
      .map((e, i) => {
        const user = escapeHtml(e.user);
        const avatar = /^https:\/\/avatars\.githubusercontent\.com\//.test(e.avatar || '')
          ? `<img src="${escapeHtml(e.avatar)}${e.avatar.includes('?') ? '&' : '?'}s=48" width="22" height="22" alt="" loading="lazy" />`
          : '<span class="lb-noavatar"></span>';
        const issue = /^https:\/\/github\.com\//.test(e.issue || '') ? `<a href="${escapeHtml(e.issue)}" target="_blank" rel="noopener">Code</a>` : '';
        const date = e.submittedAt ? new Date(e.submittedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
        return `<tr${i < 3 ? ' class="podium"' : ''}>
          <td class="rank">${i + 1}</td>
          <td class="l"><a class="lb-user" href="https://github.com/${user}" target="_blank" rel="noopener">${avatar}${user}</a></td>
          <td class="main-num">${Number(e.pathRmseCm).toFixed(2)}</td>
          <td>${Number(e.finishRmseCm).toFixed(2)}</td>
          <td>${e.finished} of ${e.runs}</td>
          <td>${escapeHtml(date)}</td>
          <td>${issue}</td>
        </tr>`;
      })
      .join('');
    frame(`
      <table class="data lb">
        <thead><tr><th>#</th><th class="l">Driver</th><th>Path RMSE, cm</th><th>Finish RMSE, cm</th><th>Finished</th><th>Submitted</th><th><span class="sr-only">Submission</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    frame('<p class="lb-empty">Loading the leaderboard…</p>');
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}leaderboard.json`, { cache: 'no-cache' });
      if (res.status === 404) return render(null);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
    } catch (e) {
      loaded = false;
      frame(`<p class="lb-empty"><span class="status bad">The leaderboard could not be loaded.</span> Check your connection and open this tab again.</p>`);
    }
  }

  async function submit() {
    const code = getCode();
    if (!code.trim()) {
      toast('controller.py is empty. Write a controller first.');
      return;
    }
    const base = `https://github.com/${repo}/issues/new?template=leaderboard.yml&title=${encodeURIComponent('Leaderboard submission')}`;
    const full = `${base}&code=${encodeURIComponent(code)}`;
    if (full.length <= MAX_URL) {
      window.open(full, '_blank', 'noopener');
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      toast('Your code is long, so it was copied instead. Paste it into the form.');
    } catch {
      toast('Your code is too long for a link. Copy it from the editor and paste it into the form.');
    }
    window.open(base, '_blank', 'noopener');
  }

  return { load };
}
