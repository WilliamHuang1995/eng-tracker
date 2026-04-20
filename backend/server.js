import 'dotenv/config';
import express from 'express';
import { Octokit } from '@octokit/rest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error('ERROR: GITHUB_TOKEN is not set in .env');
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, '../frontend');
const app = express();
app.use(express.json());
app.use(express.static(FRONTEND));

app.get('/debug', (req, res) => res.json({ __dirname, FRONTEND }));

app.get('/', (req, res) => {
  res.sendFile(join(FRONTEND, 'index.html'), err => {
    if (err) res.status(500).send(`sendFile failed: ${err.message} | FRONTEND: ${FRONTEND}`);
  });
});

// In-memory cache — 24 hour TTL
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function getWeekStart(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(d);
  monday.setUTCDate(diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

async function fetchAllPRs(owner, repo, since, until) {
  const prs = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.pulls.list({
      owner, repo,
      state: 'all',
      per_page: 100,
      page,
      sort: 'created',
      direction: 'desc',
    });

    const inRange = data.filter(pr => {
      const d = new Date(pr.created_at);
      return d >= since && d <= until;
    });
    // Tag each PR with its source repo so the processing loop uses the right API coords
    prs.push(...inRange.map(pr => ({ ...pr, _owner: owner, _repo: repo })));

    const pastRange = data.some(pr => new Date(pr.created_at) < since);
    if (data.length < 100 || pastRange) break;
    page++;
  }

  return prs;
}

// Resolve a GitHub team slug → list of member logins (lowercase)
async function resolveTeamMembers(org, teamSlug) {
  const members = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.teams.listMembersInOrg({
      org, team_slug: teamSlug, per_page: 100, page,
    });
    members.push(...data.map(m => m.login.toLowerCase()));
    if (data.length < 100) break;
    page++;
  }
  return members;
}

// Categorise a PR by type using conventional-commit prefix and GitHub labels.
// Priority: feat > fix > perf > test > chore > other
function categorizePR(pr) {
  const title = (pr.title || '').toLowerCase();
  const labels = (pr.labels || []).map(l => l.name.toLowerCase());
  // Strip optional issue-tracker prefixes like "[XFCOP-5188]: " or "(TICKET-123): "
  // before trying to match a conventional-commit prefix.
  const stripped = title.replace(/^[\[(][\w-]+[\])]\s*:?\s*/, '');
  const ccMatch = stripped.match(/^(\w+)(\(.+?\))?!?:/);
  const cc = ccMatch?.[1];
  const hasLabel = (...kws) => labels.some(l => kws.some(k => l.includes(k)));

  if (['feat', 'feature', 'add'].includes(cc) || hasLabel('feature', 'enhancement')) return 'feat';
  if (['fix', 'bugfix', 'hotfix', 'bug'].includes(cc) || hasLabel('bug', 'fix', 'hotfix')) return 'fix';
  if (['perf', 'refactor', 'optimize'].includes(cc) || hasLabel('performance', 'refactor')) return 'perf';
  if (['test', 'tests', 'spec'].includes(cc) || hasLabel('test', 'testing')) return 'test';
  if (['chore', 'docs', 'style', 'ci', 'build', 'deps', 'release', 'revert', 'infra'].includes(cc) ||
      hasLabel('chore', 'docs', 'ci', 'build', 'release', 'dependencies')) return 'chore';

  // No conventional-commit prefix — fall back to keyword scan
  if (!cc) {
    if (/\b(implement|new feature)\b/.test(title) || title.startsWith('add ')) return 'feat';
    if (/\b(fix|bug|patch|repair)\b/.test(title)) return 'fix';
    if (/\b(refactor|optimiz|perf)\b/.test(title)) return 'perf';
    if (/\b(test|spec|coverage)\b/.test(title)) return 'test';
    if (/\b(chore|docs|clean|upgrade|release|revert)\b/.test(title)) return 'chore';
  }
  return 'other';
}

// Real churn: files YOU authored that a *different* author modifies within windowDays.
// mergedPRs = [{ mergedAt: string, author: string (lower), files: Set<string> }]
function computeChurnData(mergedPRs, windowDays = 30) {
  // Work in chronological order so the inner j-loop can break early
  const sorted = [...mergedPRs].sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt));
  const result = new Map(); // login → { churnedFiles: Set, totalFiles: Set }

  const ensure = author => {
    if (!result.has(author)) result.set(author, { churnedFiles: new Set(), totalFiles: new Set() });
    return result.get(author);
  };

  for (let i = 0; i < sorted.length; i++) {
    const prA   = sorted[i];
    const timeA = new Date(prA.mergedAt).getTime();
    const dataA = ensure(prA.author);

    // Register all files authored by A in this PR
    for (const f of prA.files) dataA.totalFiles.add(f);

    // Scan subsequent PRs within the churn window
    for (let j = i + 1; j < sorted.length; j++) {
      const prB     = sorted[j];
      const diffDays = (new Date(prB.mergedAt).getTime() - timeA) / 86400000;
      if (diffDays > windowDays) break;         // sorted → safe to stop
      if (prB.author === prA.author) continue;  // self-edits excluded

      // Any file overlap = churn for A
      for (const f of prB.files) {
        if (prA.files.has(f)) dataA.churnedFiles.add(f);
      }
    }
  }
  return result;
}

app.get('/api/resolve-team', async (req, res) => {
  const { team } = req.query;
  if (!team || !team.includes('/')) {
    return res.status(400).json({ error: 'team must be org/team-slug' });
  }
  const [org, teamSlug] = team.split('/');
  try {
    const members = await resolveTeamMembers(org, teamSlug);
    res.json({ team, members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rate-limit', async (req, res) => {
  try {
    const { data } = await octokit.rateLimit.get();
    res.json(data.rate);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  const { repos = '', weeks = '4', authors = '', team = '',
          since: sinceParam = '', until: untilParam = '' } = req.query;

  // Parse repos: comma-separated "owner/repo" pairs
  const repoList = repos.split(',')
    .map(r => r.trim()).filter(Boolean)
    .map(r => {
      const [owner, repo] = r.split('/');
      return { owner: owner?.trim(), repo: repo?.trim() };
    })
    .filter(r => r.owner && r.repo);

  if (repoList.length === 0) {
    return res.status(400).json({ error: 'At least one repo is required (format: owner/repo)' });
  }

  const cacheKey = `${repos}/${sinceParam || weeks}/${untilParam}/${team || authors}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log('Cache hit');
    return res.json(cached.data);
  }

  try {
    // Resolve author filter: GitHub team takes priority over manual list
    let authorFilter = null;
    let resolvedTeam = null;
    if (team && team.includes('/')) {
      const [org, teamSlug] = team.split('/');
      console.log(`Resolving team ${team}...`);
      const members = await resolveTeamMembers(org, teamSlug);
      authorFilter = new Set(members);
      resolvedTeam = { slug: team, members };
      console.log(`  → ${members.length} members: ${members.join(', ')}`);
    } else if (authors) {
      authorFilter = new Set(authors.split(',').map(a => a.trim().toLowerCase()).filter(Boolean));
    }

    // Resolve date range — explicit since/until take priority over the weeks shortcut
    const untilDate = untilParam
      ? new Date(untilParam + 'T23:59:59.999Z')
      : new Date();
    const sinceDate = sinceParam
      ? new Date(sinceParam + 'T00:00:00.000Z')
      : (() => {
          const d = new Date(untilDate);
          d.setDate(d.getDate() - parseInt(weeks) * 7);
          return d;
        })();

    // Derive weeks count from the actual span (used for per-week averages)
    const weeksNum = Math.max(1, Math.round((untilDate - sinceDate) / (7 * 24 * 3600 * 1000)));

    // Fetch PRs from all repos in parallel; continue even if one fails
    console.log(`Fetching PRs from ${repoList.length} repo(s)  ${sinceDate.toDateString()} → ${untilDate.toDateString()}`);
    const fetchResults = await Promise.allSettled(
      repoList.map(({ owner, repo }) => fetchAllPRs(owner, repo, sinceDate, untilDate))
    );

    const failedRepos = [];
    const allPRs = [];
    fetchResults.forEach((result, i) => {
      const label = `${repoList[i].owner}/${repoList[i].repo}`;
      if (result.status === 'fulfilled') {
        console.log(`  ${label}: ${result.value.length} PRs`);
        allPRs.push(...result.value);
      } else {
        console.warn(`  ${label}: FAILED — ${result.reason?.message}`);
        failedRepos.push({ repo: label, error: result.reason?.message });
      }
    });

    console.log(`Processing ${allPRs.length} PRs total...`);

    const userStats        = new Map();
    const mergedPRsForChurn = []; // for the file-level churn pass after the main loop

    const getUser = (login, avatarUrl) => {
      if (!userStats.has(login)) {
        userStats.set(login, {
          login,
          avatarUrl: avatarUrl || `https://github.com/${login}.png?size=64`,
          prsSubmitted: 0,
          weeklyPRs: {},
          mergeTimes: [],
          commentsOnOthers: 0,
          weeklyComments: {},
          approvalsTotal: 0,
          approvalsWithoutComments: 0,
          // Code size (raw lines per PR)
          totalAdditions: 0,
          totalDeletions: 0,
          totalFilesChanged: 0,
          // PR type breakdown (conventional-commit / label heuristic)
          prsByType: { feat: 0, fix: 0, perf: 0, test: 0, chore: 0, other: 0 },
        });
      }
      return userStats.get(login);
    };

    for (const pr of allPRs) {
      const author = pr.user?.login;
      if (!author || author === 'ghost') continue;

      // Use the repo coords tagged onto this PR during fetch
      const prOwner = pr._owner;
      const prRepo  = pr._repo;

      const user = getUser(author, pr.user.avatar_url);
      user.prsSubmitted++;
      user.prsByType[categorizePR(pr)]++;

      const wk = getWeekStart(pr.created_at);
      user.weeklyPRs[wk] = (user.weeklyPRs[wk] || 0) + 1;

      if (pr.merged_at) {
        const hours = (new Date(pr.merged_at) - new Date(pr.created_at)) / 3600000;
        user.mergeTimes.push(parseFloat(hours.toFixed(2)));
      }

      // Fetch PR detail (size) + reviews + comments + file list in parallel
      const [prDetail, reviews, reviewComments, issueComments, prFileList] = await Promise.all([
        octokit.pulls.get({ owner: prOwner, repo: prRepo, pull_number: pr.number })
          .then(r => r.data).catch(() => ({})),
        octokit.pulls.listReviews({ owner: prOwner, repo: prRepo, pull_number: pr.number })
          .then(r => r.data).catch(() => []),
        octokit.pulls.listReviewComments({ owner: prOwner, repo: prRepo, pull_number: pr.number })
          .then(r => r.data).catch(() => []),
        octokit.issues.listComments({ owner: prOwner, repo: prRepo, issue_number: pr.number })
          .then(r => r.data).catch(() => []),
        octokit.pulls.listFiles({ owner: prOwner, repo: prRepo, pull_number: pr.number })
          .then(r => r.data.map(f => f.filename)).catch(() => []),
      ]);

      // Accumulate code-size stats
      user.totalAdditions    += prDetail.additions     || 0;
      user.totalDeletions    += prDetail.deletions     || 0;
      user.totalFilesChanged += prDetail.changed_files || 0;

      // Record merged PR for cross-author churn detection (30-day window, computed after loop)
      if (pr.merged_at) {
        mergedPRsForChurn.push({
          mergedAt: pr.merged_at,
          author:   author.toLowerCase(),
          files:    new Set(prFileList),
        });
      }

      // Track who commented on this PR (excluding the PR author)
      const commentersOnPR = new Set();

      for (const comment of [...reviewComments, ...issueComments]) {
        const commenter = comment.user?.login;
        if (!commenter || commenter === author || commenter === 'ghost') continue;

        const u = getUser(commenter, comment.user.avatar_url);
        u.commentsOnOthers++;

        const cwk = getWeekStart(comment.created_at);
        u.weeklyComments[cwk] = (u.weeklyComments[cwk] || 0) + 1;
        commentersOnPR.add(commenter);
      }

      // Process review approvals
      for (const review of reviews) {
        const reviewer = review.user?.login;
        if (!reviewer || reviewer === author || reviewer === 'ghost') continue;
        if (review.state !== 'APPROVED') continue;

        const u = getUser(reviewer, review.user.avatar_url);
        u.approvalsTotal++;
        if (!commentersOnPR.has(reviewer)) {
          u.approvalsWithoutComments++;
        }
      }
    }

    // File-level churn pass: files authored by A reworked by another person within 30 days
    const churnData = computeChurnData(mergedPRsForChurn);

    const stats = Array.from(userStats.values())
      .filter(u => !authorFilter || authorFilter.has(u.login.toLowerCase()))
      .map(u => {
        const avgMerge = u.mergeTimes.length > 0
          ? u.mergeTimes.reduce((a, b) => a + b, 0) / u.mergeTimes.length
          : null;

        const n = u.prsSubmitted || 1; // avoid div/0

        // Churn score: % of files you authored that someone else touched within 30 days
        const churnEntry    = churnData.get(u.login.toLowerCase());
        const churnedFiles  = churnEntry?.churnedFiles.size ?? 0;
        const filesAuthored = churnEntry?.totalFiles.size  ?? 0;
        const churnScore    = filesAuthored > 0
          ? parseFloat((churnedFiles / filesAuthored * 100).toFixed(1))
          : null; // null = no merged PRs to measure against

        return {
          login: u.login,
          avatarUrl: u.avatarUrl,
          prsSubmitted: u.prsSubmitted,
          weeklyPRAvg: parseFloat((u.prsSubmitted / weeksNum).toFixed(1)),
          weeklyPRs: u.weeklyPRs,
          // PR type breakdown
          prsByType: u.prsByType,
          // Merge stats
          mergedPRs: u.mergeTimes.length,
          avgMergeTimeHours: avgMerge !== null ? parseFloat(avgMerge.toFixed(1)) : null,
          minMergeTimeHours: u.mergeTimes.length ? parseFloat(Math.min(...u.mergeTimes).toFixed(1)) : null,
          maxMergeTimeHours: u.mergeTimes.length ? parseFloat(Math.max(...u.mergeTimes).toFixed(1)) : null,
          // Code size (raw lines)
          totalAdditions: u.totalAdditions,
          totalDeletions: u.totalDeletions,
          avgAdditions: Math.round(u.totalAdditions / n),
          avgDeletions: Math.round(u.totalDeletions / n),
          avgPRSize: Math.round((u.totalAdditions + u.totalDeletions) / n),
          avgFilesChanged: parseFloat((u.totalFilesChanged / n).toFixed(1)),
          // Real churn: files reworked by others within 30 days of your merge
          churnedFiles,
          filesAuthored,
          churnScore,
          // Review engagement
          commentsOnOthers: u.commentsOnOthers,
          weeklyCommentAvg: parseFloat((u.commentsOnOthers / weeksNum).toFixed(1)),
          weeklyComments: u.weeklyComments,
          approvalsTotal: u.approvalsTotal,
          approvalsWithoutComments: u.approvalsWithoutComments,
        };
      }).sort((a, b) => b.prsSubmitted - a.prsSubmitted);

    const result = {
      stats,
      meta: {
        repos: repoList.map(r => `${r.owner}/${r.repo}`),
        failedRepos,
        weeks: weeksNum,
        since: sinceDate.toISOString(),
        until: untilDate.toISOString(),
        totalPRs: allPRs.length,
        resolvedTeam,
        authorFilter: authorFilter ? Array.from(authorFilter) : null,
        generatedAt: new Date().toISOString(),
      },
    };

    cache.set(cacheKey, { data: result, ts: Date.now() });
    console.log(`Done. ${stats.length} contributors found.`);
    res.json(result);

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  Eng Tracker  →  http://localhost:${PORT}\n`);
});
