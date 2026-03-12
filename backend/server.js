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
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '../frontend')));

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

async function fetchAllPRs(owner, repo, since) {
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

    const inRange = data.filter(pr => new Date(pr.created_at) >= since);
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
  const { repos = '', weeks = '4', authors = '', team = '' } = req.query;

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

  const cacheKey = `${repos}/${weeks}/${team || authors}`;
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

    const weeksNum = parseInt(weeks);
    const since = new Date();
    since.setDate(since.getDate() - weeksNum * 7);

    // Fetch PRs from all repos in parallel; continue even if one fails
    console.log(`Fetching PRs from ${repoList.length} repo(s) since ${since.toDateString()}`);
    const fetchResults = await Promise.allSettled(
      repoList.map(({ owner, repo }) => fetchAllPRs(owner, repo, since))
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

    const userStats = new Map();

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
          // Code churn
          totalAdditions: 0,
          totalDeletions: 0,
          totalFilesChanged: 0,
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

      const wk = getWeekStart(pr.created_at);
      user.weeklyPRs[wk] = (user.weeklyPRs[wk] || 0) + 1;

      if (pr.merged_at) {
        const hours = (new Date(pr.merged_at) - new Date(pr.created_at)) / 3600000;
        user.mergeTimes.push(parseFloat(hours.toFixed(2)));
      }

      // Fetch PR detail (churn) + reviews + comments in parallel
      const [prDetail, reviews, reviewComments, issueComments] = await Promise.all([
        octokit.pulls.get({ owner: prOwner, repo: prRepo, pull_number: pr.number })
          .then(r => r.data).catch(() => ({})),
        octokit.pulls.listReviews({ owner: prOwner, repo: prRepo, pull_number: pr.number })
          .then(r => r.data).catch(() => []),
        octokit.pulls.listReviewComments({ owner: prOwner, repo: prRepo, pull_number: pr.number })
          .then(r => r.data).catch(() => []),
        octokit.issues.listComments({ owner: prOwner, repo: prRepo, issue_number: pr.number })
          .then(r => r.data).catch(() => []),
      ]);

      // Accumulate churn
      user.totalAdditions    += prDetail.additions     || 0;
      user.totalDeletions    += prDetail.deletions     || 0;
      user.totalFilesChanged += prDetail.changed_files || 0;

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

    const stats = Array.from(userStats.values())
      .filter(u => !authorFilter || authorFilter.has(u.login.toLowerCase()))
      .map(u => {
        const avgMerge = u.mergeTimes.length > 0
          ? u.mergeTimes.reduce((a, b) => a + b, 0) / u.mergeTimes.length
          : null;

        const n = u.prsSubmitted || 1; // avoid div/0
        return {
          login: u.login,
          avatarUrl: u.avatarUrl,
          prsSubmitted: u.prsSubmitted,
          weeklyPRAvg: parseFloat((u.prsSubmitted / weeksNum).toFixed(1)),
          weeklyPRs: u.weeklyPRs,
          // Merge stats
          mergedPRs: u.mergeTimes.length,
          avgMergeTimeHours: avgMerge !== null ? parseFloat(avgMerge.toFixed(1)) : null,
          minMergeTimeHours: u.mergeTimes.length ? parseFloat(Math.min(...u.mergeTimes).toFixed(1)) : null,
          maxMergeTimeHours: u.mergeTimes.length ? parseFloat(Math.max(...u.mergeTimes).toFixed(1)) : null,
          // Code churn & size
          totalAdditions: u.totalAdditions,
          totalDeletions: u.totalDeletions,
          totalChurn: u.totalAdditions + u.totalDeletions,
          avgAdditions: Math.round(u.totalAdditions / n),
          avgDeletions: Math.round(u.totalDeletions / n),
          avgPRSize: Math.round((u.totalAdditions + u.totalDeletions) / n),
          avgFilesChanged: parseFloat((u.totalFilesChanged / n).toFixed(1)),
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
        since: since.toISOString(),
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
