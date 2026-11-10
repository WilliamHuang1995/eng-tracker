import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, '../frontend');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});
app.use(express.static(FRONTEND));

function requireToken(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'GitHub token required.' });
  req.token = token;
  next();
}

app.get('/', (req, res) => res.sendFile(join(FRONTEND, 'index.html')));

// ─── GraphQL helper ───────────────────────────────────────────
async function graphql(token, query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

// Retry transient GitHub failures (HTML error pages, truncated/invalid JSON,
// secondary rate limits) with exponential backoff before giving up.
async function graphqlWithRetry(token, query, variables = {}, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await graphql(token, query, variables);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const delay = 1000 * 2 ** i; // 1s, 2s, 4s
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── GraphQL queries ──────────────────────────────────────────
const PR_QUERY = `
query($searchQuery: String!, $cursor: String) {
  search(query: $searchQuery, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        createdAt
        mergedAt
        state
        additions
        deletions
        changedFiles
        author { login avatarUrl }
        labels(first: 10) { nodes { name } }
        files(first: 50) { nodes { path } }
        reviews(first: 50) {
          nodes {
            state
            author { login avatarUrl }
          }
        }
        reviewThreads(first: 100) {
          nodes {
            comments(first: 50) {
              nodes {
                author { login avatarUrl }
                body
                createdAt
                path
              }
            }
          }
        }
        comments(first: 50) {
          nodes {
            author { login avatarUrl }
            body
            createdAt
          }
        }
      }
    }
  }
}`;

const TEAM_QUERY = `
query($org: String!, $teamSlug: String!, $cursor: String) {
  organization(login: $org) {
    team(slug: $teamSlug) {
      members(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { login }
      }
    }
  }
}`;

// ─── Fetch from GitHub and store in DB ────────────────────────
async function fetchAndStore(token, owner, repo, since, until) {
  const prs = [];
  const chunks = [];
  let chunkStart = new Date(since);
  while (chunkStart < until) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setMonth(chunkEnd.getMonth() + 1);
    if (chunkEnd > until) chunkEnd.setTime(until.getTime());
    chunks.push({ start: new Date(chunkStart), end: new Date(chunkEnd) });
    chunkStart = chunkEnd;
  }

  const repoStr = `${owner}/${repo}`;

  for (const chunk of chunks) {
    const sinceStr = chunk.start.toISOString().split('T')[0];
    const untilStr = chunk.end.toISOString().split('T')[0];

    // Skip only chunks we previously paged through in full. A chunk that
    // errored mid-way is never marked complete, so it is retried here.
    if (await db.isChunkComplete(repoStr, sinceStr, untilStr)) {
      console.log(`  [skip] ${owner}/${repo} ${sinceStr}..${untilStr} — already complete`);
      continue;
    }

    let cursor = null;
    let page = 0;
    let chunkOk = true;
    const searchQuery = `is:pr repo:${owner}/${repo} created:${sinceStr}..${untilStr}`;

    while (true) {
      page++;
      let data;
      try {
        data = await graphqlWithRetry(token, PR_QUERY, { searchQuery, cursor });
      } catch (err) {
        // Transient errors (HTML error pages, truncated JSON) survive the
        // retries sometimes. Give up on this chunk but keep going on the
        // rest of the repo; leave the chunk unmarked so it retries next sync.
        console.warn(`  [GraphQL] ${owner}/${repo} ${sinceStr}..${untilStr} page ${page}: ERROR — ${err.message} (skipping chunk, will retry next sync)`);
        chunkOk = false;
        break;
      }

      const searchData = data.search;
      const nodes = searchData.nodes.filter(n => n.number);

      for (const pr of nodes) {
        const prId = await db.upsertPR({
          repo: repoStr,
          number: pr.number,
          title: pr.title,
          authorLogin: pr.author?.login || 'ghost',
          authorAvatarUrl: pr.author?.avatarUrl || null,
          createdAt: pr.createdAt,
          mergedAt: pr.mergedAt || null,
          state: pr.state,
          additions: pr.additions || 0,
          deletions: pr.deletions || 0,
          changedFiles: pr.changedFiles || 0,
          labels: (pr.labels?.nodes || []).map(l => l.name),
        });

        // Reviews
        const reviews = (pr.reviews?.nodes || [])
          .filter(r => r.author?.login)
          .map(r => ({ login: r.author.login, avatarUrl: r.author.avatarUrl, state: r.state }));
        await db.insertReviews(prId, reviews);

        // Comments from review threads + issue comments
        const comments = [];
        for (const thread of (pr.reviewThreads?.nodes || [])) {
          for (const c of (thread.comments?.nodes || [])) {
            if (!c.author?.login) continue;
            comments.push({
              login: c.author.login,
              avatarUrl: c.author.avatarUrl,
              body: c.body,
              createdAt: c.createdAt,
              path: c.path || null,
              type: 'review_thread',
            });
          }
        }
        for (const c of (pr.comments?.nodes || [])) {
          if (!c.author?.login) continue;
          comments.push({
            login: c.author.login,
            avatarUrl: c.author.avatarUrl,
            body: c.body,
            createdAt: c.createdAt,
            path: null,
            type: 'issue_comment',
          });
        }
        await db.insertComments(prId, comments);

        // Files
        const files = (pr.files?.nodes || []).map(f => f.path);
        await db.insertFiles(prId, files);

        prs.push(pr);
      }

      console.log(`  [GraphQL] ${owner}/${repo} ${sinceStr}..${untilStr} page ${page}: ${nodes.length} PRs (total so far: ${prs.length})`);

      if (!searchData.pageInfo.hasNextPage) break;
      cursor = searchData.pageInfo.endCursor;
    }

    // Only record the chunk as done if every page came back cleanly.
    if (chunkOk) await db.markChunkComplete(repoStr, sinceStr, untilStr);
  }

  return prs.length;
}

async function resolveTeamMembers(token, org, teamSlug) {
  const members = [];
  let cursor = null;
  while (true) {
    const data = await graphql(token, TEAM_QUERY, { org, teamSlug, cursor });
    const team = data.organization.team;
    if (!team) throw new Error(`Team ${org}/${teamSlug} not found`);
    const memberData = team.members;
    members.push(...memberData.nodes.map(m => m.login.toLowerCase()));
    if (!memberData.pageInfo.hasNextPage) break;
    cursor = memberData.pageInfo.endCursor;
  }
  return members;
}

// ─── Helpers ──────────────────────────────────────────────────
function getWeekStart(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setUTCDate(diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

function categorizePR(title, labels) {
  title = (title || '').toLowerCase();
  labels = (labels || []).map(l => l.toLowerCase());
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

  if (!cc) {
    if (/\b(implement|new feature)\b/.test(title) || title.startsWith('add ')) return 'feat';
    if (/\b(fix|bug|patch|repair)\b/.test(title)) return 'fix';
    if (/\b(refactor|optimiz|perf)\b/.test(title)) return 'perf';
    if (/\b(test|spec|coverage)\b/.test(title)) return 'test';
    if (/\b(chore|docs|clean|upgrade|release|revert)\b/.test(title)) return 'chore';
  }
  return 'other';
}

function computeChurnData(mergedPRs, windowDays = 30) {
  const sorted = [...mergedPRs].sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt));
  const result = new Map();
  const ensure = author => {
    if (!result.has(author)) result.set(author, { churnedFiles: new Set(), totalFiles: new Set() });
    return result.get(author);
  };
  for (let i = 0; i < sorted.length; i++) {
    const prA = sorted[i];
    const timeA = new Date(prA.mergedAt).getTime();
    const dataA = ensure(prA.author);
    for (const f of prA.files) dataA.totalFiles.add(f);
    for (let j = i + 1; j < sorted.length; j++) {
      const prB = sorted[j];
      const diffDays = (new Date(prB.mergedAt).getTime() - timeA) / 86400000;
      if (diffDays > windowDays) break;
      if (prB.author === prA.author) continue;
      for (const f of prB.files) {
        if (prA.files.has(f)) dataA.churnedFiles.add(f);
      }
    }
  }
  return result;
}

// ─── API: Sync data from GitHub ───────────────────────────────
app.post('/api/sync', requireToken, async (req, res) => {
  const { repos = '', since = '', until = '', team = '' } = req.body;

  const repoList = repos.split(',')
    .map(r => r.trim()).filter(Boolean)
    .map(r => { const [owner, repo] = r.split('/'); return { owner: owner?.trim(), repo: repo?.trim() }; })
    .filter(r => r.owner && r.repo);

  if (repoList.length === 0) return res.status(400).json({ error: 'At least one repo required' });
  if (!since || !until) return res.status(400).json({ error: 'since and until required' });

  const sinceDate = new Date(since + 'T00:00:00.000Z');
  const untilDate = new Date(until + 'T23:59:59.999Z');

  let resolvedTeam = null;
  if (team && team.includes('/')) {
    const [org, teamSlug] = team.split('/');
    try {
      const members = await resolveTeamMembers(req.token, org, teamSlug);
      resolvedTeam = { slug: team, members };
      console.log(`Resolved team ${team}: ${members.length} members`);
    } catch (err) {
      return res.status(500).json({ error: `Failed to resolve team: ${err.message}` });
    }
  }

  console.log(`Syncing ${repoList.length} repo(s) via GraphQL  ${sinceDate.toDateString()} → ${untilDate.toDateString()}`);

  const results = [];
  for (const { owner, repo } of repoList) {
    try {
      const count = await fetchAndStore(req.token, owner, repo, sinceDate, untilDate);
      results.push({ repo: `${owner}/${repo}`, prs: count, status: 'ok' });
      console.log(`  ${owner}/${repo}: ${count} PRs stored`);
    } catch (err) {
      results.push({ repo: `${owner}/${repo}`, prs: 0, status: 'error', error: err.message });
      console.warn(`  ${owner}/${repo}: FAILED — ${err.message}`);
    }
  }

  res.json({ results, resolvedTeam });
});

// ─── API: Resolve team ────────────────────────────────────────
app.get('/api/resolve-team', requireToken, async (req, res) => {
  const { team } = req.query;
  if (!team || !team.includes('/')) return res.status(400).json({ error: 'team must be org/team-slug' });
  const [org, teamSlug] = team.split('/');
  try {
    const members = await resolveTeamMembers(req.token, org, teamSlug);
    res.json({ team, members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Rate limit ──────────────────────────────────────────
app.get('/api/rate-limit', requireToken, async (req, res) => {
  try {
    const data = await graphql(req.token, `query { rateLimit { limit remaining resetAt } }`);
    res.json(data.rateLimit);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Stats (reads from DB) ──────────────────────────────
app.get('/api/stats', async (req, res) => {
  const { repos = '', weeks = '4', authors = '', team = '',
          since: sinceParam = '', until: untilParam = '' } = req.query;

  const repoList = repos.split(',').map(r => r.trim()).filter(Boolean);

  const untilDate = untilParam
    ? new Date(untilParam + 'T23:59:59.999Z')
    : new Date();
  const sinceDate = sinceParam
    ? new Date(sinceParam + 'T00:00:00.000Z')
    : (() => { const d = new Date(untilDate); d.setDate(d.getDate() - parseInt(weeks) * 7); return d; })();

  const weeksNum = Math.max(1, Math.round((untilDate - sinceDate) / (7 * 24 * 3600 * 1000)));

  try {
    // Resolve author filter
    let authorFilter = null;
    if (authors) {
      authorFilter = new Set(authors.split(',').map(a => a.trim().toLowerCase()).filter(Boolean));
    }

    // Read from DB
    const prs = await db.getPRs(repoList, sinceDate, untilDate);

    if (prs.length === 0) {
      return res.json({
        stats: [],
        meta: { repos: repoList, failedRepos: [], weeks: weeksNum, since: sinceDate.toISOString(), until: untilDate.toISOString(), totalPRs: 0, authorFilter: authorFilter ? Array.from(authorFilter) : null, generatedAt: new Date().toISOString() },
      });
    }

    const prIds = prs.map(p => p.id);
    const [allReviews, allComments, allFiles] = await Promise.all([
      db.getReviewsForPRs(prIds),
      db.getCommentsForPRs(prIds),
      db.getFilesForPRs(prIds),
    ]);

    // Index by pr_id
    const reviewsByPR = new Map();
    for (const r of allReviews) {
      if (!reviewsByPR.has(r.pr_id)) reviewsByPR.set(r.pr_id, []);
      reviewsByPR.get(r.pr_id).push(r);
    }
    const commentsByPR = new Map();
    for (const c of allComments) {
      if (!commentsByPR.has(c.pr_id)) commentsByPR.set(c.pr_id, []);
      commentsByPR.get(c.pr_id).push(c);
    }
    const filesByPR = new Map();
    for (const f of allFiles) {
      if (!filesByPR.has(f.pr_id)) filesByPR.set(f.pr_id, []);
      filesByPR.get(f.pr_id).push(f.path);
    }

    // Process stats
    const userStats = new Map();
    const mergedPRsForChurn = [];

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
          totalAdditions: 0,
          totalDeletions: 0,
          totalFilesChanged: 0,
          prsByType: { feat: 0, fix: 0, perf: 0, test: 0, chore: 0, other: 0 },
        });
      }
      return userStats.get(login);
    };

    for (const pr of prs) {
      const author = pr.author_login;
      if (!author || author === 'ghost') continue;

      const user = getUser(author, pr.author_avatar_url);
      user.prsSubmitted++;

      const labels = JSON.parse(pr.labels || '[]');
      user.prsByType[categorizePR(pr.title, labels)]++;

      const wk = getWeekStart(pr.created_at);
      user.weeklyPRs[wk] = (user.weeklyPRs[wk] || 0) + 1;

      if (pr.merged_at) {
        const hours = (new Date(pr.merged_at) - new Date(pr.created_at)) / 3600000;
        user.mergeTimes.push(parseFloat(hours.toFixed(2)));
      }

      user.totalAdditions += pr.additions || 0;
      user.totalDeletions += pr.deletions || 0;
      user.totalFilesChanged += pr.changed_files || 0;

      const fileList = filesByPR.get(pr.id) || [];
      if (pr.merged_at) {
        mergedPRsForChurn.push({
          mergedAt: pr.merged_at,
          author: author.toLowerCase(),
          files: new Set(fileList),
        });
      }

      const prComments = commentsByPR.get(pr.id) || [];
      const prReviews = reviewsByPR.get(pr.id) || [];
      const commentersOnPR = new Set();

      for (const comment of prComments) {
        const commenter = comment.author_login;
        if (!commenter || commenter === author || commenter === 'ghost') continue;

        const u = getUser(commenter, comment.author_avatar_url);
        u.commentsOnOthers++;

        const cwk = getWeekStart(comment.created_at);
        u.weeklyComments[cwk] = (u.weeklyComments[cwk] || 0) + 1;
        commentersOnPR.add(commenter);
      }

      for (const review of prReviews) {
        const reviewer = review.reviewer_login;
        if (!reviewer || reviewer === author || reviewer === 'ghost') continue;
        if (review.state !== 'APPROVED') continue;

        const u = getUser(reviewer, review.reviewer_avatar_url);
        u.approvalsTotal++;
        if (!commentersOnPR.has(reviewer)) {
          u.approvalsWithoutComments++;
        }
      }
    }

    const churnData = computeChurnData(mergedPRsForChurn);

    const stats = Array.from(userStats.values())
      .filter(u => !authorFilter || authorFilter.has(u.login.toLowerCase()))
      .map(u => {
        const avgMerge = u.mergeTimes.length > 0
          ? u.mergeTimes.reduce((a, b) => a + b, 0) / u.mergeTimes.length : null;
        const n = u.prsSubmitted || 1;
        const churnEntry = churnData.get(u.login.toLowerCase());
        const churnedFiles = churnEntry?.churnedFiles.size ?? 0;
        const filesAuthored = churnEntry?.totalFiles.size ?? 0;
        const churnScore = filesAuthored > 0
          ? parseFloat((churnedFiles / filesAuthored * 100).toFixed(1)) : null;

        return {
          login: u.login,
          avatarUrl: u.avatarUrl,
          prsSubmitted: u.prsSubmitted,
          weeklyPRAvg: parseFloat((u.prsSubmitted / weeksNum).toFixed(1)),
          weeklyPRs: u.weeklyPRs,
          prsByType: u.prsByType,
          mergedPRs: u.mergeTimes.length,
          avgMergeTimeHours: avgMerge !== null ? parseFloat(avgMerge.toFixed(1)) : null,
          minMergeTimeHours: u.mergeTimes.length ? parseFloat(Math.min(...u.mergeTimes).toFixed(1)) : null,
          maxMergeTimeHours: u.mergeTimes.length ? parseFloat(Math.max(...u.mergeTimes).toFixed(1)) : null,
          totalAdditions: u.totalAdditions,
          totalDeletions: u.totalDeletions,
          avgAdditions: Math.round(u.totalAdditions / n),
          avgDeletions: Math.round(u.totalDeletions / n),
          avgPRSize: Math.round((u.totalAdditions + u.totalDeletions) / n),
          avgFilesChanged: parseFloat((u.totalFilesChanged / n).toFixed(1)),
          churnedFiles,
          filesAuthored,
          churnScore,
          commentsOnOthers: u.commentsOnOthers,
          weeklyCommentAvg: parseFloat((u.commentsOnOthers / weeksNum).toFixed(1)),
          weeklyComments: u.weeklyComments,
          approvalsTotal: u.approvalsTotal,
          approvalsWithoutComments: u.approvalsWithoutComments,
        };
      }).sort((a, b) => b.prsSubmitted - a.prsSubmitted);

    const filteredTotalPRs = stats.reduce((sum, u) => sum + u.prsSubmitted, 0);

    res.json({
      stats,
      meta: {
        repos: repoList,
        failedRepos: [],
        weeks: weeksNum,
        since: sinceDate.toISOString(),
        until: untilDate.toISOString(),
        totalPRs: filteredTotalPRs,
        authorFilter: authorFilter ? Array.from(authorFilter) : null,
        generatedAt: new Date().toISOString(),
      },
    });

  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Comments (reads from DB) ───────────────────────────
app.get('/api/comments', async (req, res) => {
  const { repos = '', author = '', since: sinceParam = '', until: untilParam = '', weeks = '4' } = req.query;

  if (!author) return res.status(400).json({ error: 'author is required' });

  const repoList = repos.split(',').map(r => r.trim()).filter(Boolean);

  const untilDate = untilParam ? new Date(untilParam + 'T23:59:59.999Z') : new Date();
  const sinceDate = sinceParam
    ? new Date(sinceParam + 'T00:00:00.000Z')
    : (() => { const d = new Date(untilDate); d.setDate(d.getDate() - parseInt(weeks) * 7); return d; })();

  try {
    const rows = await db.getCommentsByAuthor(repoList, sinceDate, untilDate, author.toLowerCase());

    const comments = rows.map(r => ({
      pr: { number: r.pr_number, title: r.pr_title, author: r.pr_author, repo: r.pr_repo },
      body: r.body,
      createdAt: r.created_at,
      path: r.path || null,
    }));

    res.json({
      author,
      since: sinceDate.toISOString(),
      until: untilDate.toISOString(),
      totalComments: comments.length,
      comments,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
await db.ensureSchema();
app.listen(PORT, () => {
  console.log(`\n  Eng Tracker  →  http://localhost:${PORT}\n`);
});
