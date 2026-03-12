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

// Simple in-memory cache (5 min TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getWeekStart(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(d);
  monday.setUTCDate(diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

async function fetchAllPRs(octokit, owner, repo, since) {
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
    prs.push(...inRange);

    const pastRange = data.some(pr => new Date(pr.created_at) < since);
    if (data.length < 100 || pastRange) break;
    page++;
  }

  return prs;
}

app.get('/api/rate-limit', async (req, res) => {
  try {
    const { data } = await octokit.rateLimit.get();
    res.json(data.rate);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  const { owner, repo, weeks = '4', authors = '' } = req.query;

  if (!owner || !repo) {
    return res.status(400).json({ error: 'owner and repo are required' });
  }

  // Parse optional authors filter (case-insensitive)
  const authorFilter = authors
    ? new Set(authors.split(',').map(a => a.trim().toLowerCase()).filter(Boolean))
    : null;

  const cacheKey = `${owner}/${repo}/${weeks}/${authors}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log('Cache hit');
    return res.json(cached.data);
  }

  try {
    const weeksNum = parseInt(weeks);
    const since = new Date();
    since.setDate(since.getDate() - weeksNum * 7);

    console.log(`Fetching PRs for ${owner}/${repo} since ${since.toDateString()}`);
    const prs = await fetchAllPRs(octokit, owner, repo, since);
    console.log(`Processing ${prs.length} PRs...`);

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
        });
      }
      return userStats.get(login);
    };

    for (const pr of prs) {
      const author = pr.user?.login;
      if (!author || author === 'ghost') continue;

      const user = getUser(author, pr.user.avatar_url);
      user.prsSubmitted++;

      const wk = getWeekStart(pr.created_at);
      user.weeklyPRs[wk] = (user.weeklyPRs[wk] || 0) + 1;

      if (pr.merged_at) {
        const hours = (new Date(pr.merged_at) - new Date(pr.created_at)) / 3600000;
        user.mergeTimes.push(parseFloat(hours.toFixed(2)));
      }

      // Fetch reviews + review comments + issue comments in parallel
      const [reviews, reviewComments, issueComments] = await Promise.all([
        octokit.pulls.listReviews({ owner, repo, pull_number: pr.number })
          .then(r => r.data).catch(() => []),
        octokit.pulls.listReviewComments({ owner, repo, pull_number: pr.number })
          .then(r => r.data).catch(() => []),
        octokit.issues.listComments({ owner, repo, issue_number: pr.number })
          .then(r => r.data).catch(() => []),
      ]);

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
        // "Silent approval" = approved without leaving any comment on this PR
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

        return {
          login: u.login,
          avatarUrl: u.avatarUrl,
          prsSubmitted: u.prsSubmitted,
          weeklyPRAvg: parseFloat((u.prsSubmitted / weeksNum).toFixed(1)),
          weeklyPRs: u.weeklyPRs,
          mergedPRs: u.mergeTimes.length,
          avgMergeTimeHours: avgMerge !== null ? parseFloat(avgMerge.toFixed(1)) : null,
          minMergeTimeHours: u.mergeTimes.length ? parseFloat(Math.min(...u.mergeTimes).toFixed(1)) : null,
          maxMergeTimeHours: u.mergeTimes.length ? parseFloat(Math.max(...u.mergeTimes).toFixed(1)) : null,
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
        owner, repo,
        weeks: weeksNum,
        since: since.toISOString(),
        totalPRs: prs.length,
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
