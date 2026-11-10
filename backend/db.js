import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'rootpassword',
  database: process.env.DB_NAME || 'eng_tracker',
  waitForConnections: true,
  connectionLimit: 10,
});

function toMySQLDatetime(isoStr) {
  if (!isoStr) return null;
  return new Date(isoStr).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

// Creates every table the app needs if it is missing, so a fresh clone can
// scaffold the schema just by starting the server. Idempotent — safe to run on
// every boot. The *_chunks table tracks which (repo, date-range) windows were
// fully paged through, so a later sync skips completed work without skipping
// chunks that only partially stored.
export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pull_requests (
      id                BIGINT NOT NULL AUTO_INCREMENT,
      repo              VARCHAR(255) NOT NULL,
      number            INT NOT NULL,
      title             TEXT,
      author_login      VARCHAR(255) NOT NULL,
      author_avatar_url TEXT,
      created_at        DATETIME NOT NULL,
      merged_at         DATETIME,
      state             VARCHAR(50),
      additions         INT DEFAULT 0,
      deletions         INT DEFAULT 0,
      changed_files     INT DEFAULT 0,
      labels            JSON,
      fetched_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_repo_number (repo, number),
      KEY idx_author (author_login),
      KEY idx_created (created_at),
      KEY idx_repo_created (repo, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pr_reviews (
      id                  BIGINT NOT NULL AUTO_INCREMENT,
      pr_id               BIGINT NOT NULL,
      reviewer_login      VARCHAR(255) NOT NULL,
      reviewer_avatar_url TEXT,
      state               VARCHAR(50) NOT NULL,
      PRIMARY KEY (id),
      KEY idx_pr (pr_id),
      KEY idx_reviewer (reviewer_login),
      CONSTRAINT pr_reviews_ibfk_1 FOREIGN KEY (pr_id) REFERENCES pull_requests (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pr_comments (
      id                BIGINT NOT NULL AUTO_INCREMENT,
      pr_id             BIGINT NOT NULL,
      author_login      VARCHAR(255) NOT NULL,
      author_avatar_url TEXT,
      body              MEDIUMTEXT,
      created_at        DATETIME NOT NULL,
      path              VARCHAR(500),
      comment_type      ENUM('review_thread','issue_comment') NOT NULL,
      PRIMARY KEY (id),
      KEY idx_pr (pr_id),
      KEY idx_author (author_login),
      KEY idx_created (created_at),
      CONSTRAINT pr_comments_ibfk_1 FOREIGN KEY (pr_id) REFERENCES pull_requests (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pr_files (
      id    BIGINT NOT NULL AUTO_INCREMENT,
      pr_id BIGINT NOT NULL,
      path  VARCHAR(500) NOT NULL,
      PRIMARY KEY (id),
      KEY idx_pr (pr_id),
      CONSTRAINT pr_files_ibfk_1 FOREIGN KEY (pr_id) REFERENCES pull_requests (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_chunks (
      repo        VARCHAR(255) NOT NULL,
      chunk_start DATE NOT NULL,
      chunk_end   DATE NOT NULL,
      completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repo, chunk_start, chunk_end)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function isChunkComplete(repo, chunkStart, chunkEnd) {
  const [rows] = await pool.query(
    'SELECT 1 FROM sync_chunks WHERE repo = ? AND chunk_start = ? AND chunk_end = ? LIMIT 1',
    [repo, chunkStart, chunkEnd]
  );
  return rows.length > 0;
}

export async function markChunkComplete(repo, chunkStart, chunkEnd) {
  await pool.execute(
    `INSERT INTO sync_chunks (repo, chunk_start, chunk_end) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE completed_at = CURRENT_TIMESTAMP`,
    [repo, chunkStart, chunkEnd]
  );
}

export async function upsertPR(pr) {
  const [result] = await pool.execute(
    `INSERT INTO pull_requests (repo, number, title, author_login, author_avatar_url, created_at, merged_at, state, additions, deletions, changed_files, labels)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       title = VALUES(title),
       merged_at = VALUES(merged_at),
       state = VALUES(state),
       additions = VALUES(additions),
       deletions = VALUES(deletions),
       changed_files = VALUES(changed_files),
       labels = VALUES(labels),
       fetched_at = CURRENT_TIMESTAMP`,
    [
      pr.repo,
      pr.number,
      pr.title,
      pr.authorLogin,
      pr.authorAvatarUrl,
      toMySQLDatetime(pr.createdAt),
      toMySQLDatetime(pr.mergedAt),
      pr.state,
      pr.additions || 0,
      pr.deletions || 0,
      pr.changedFiles || 0,
      JSON.stringify(pr.labels || []),
    ]
  );
  // Get the PR id (either newly inserted or existing)
  if (result.insertId) return result.insertId;
  const [rows] = await pool.execute(
    'SELECT id FROM pull_requests WHERE repo = ? AND number = ?',
    [pr.repo, pr.number]
  );
  return rows[0].id;
}

export async function insertReviews(prId, reviews) {
  if (!reviews.length) return;
  await pool.execute('DELETE FROM pr_reviews WHERE pr_id = ?', [prId]);
  for (const r of reviews) {
    await pool.execute(
      'INSERT INTO pr_reviews (pr_id, reviewer_login, reviewer_avatar_url, state) VALUES (?, ?, ?, ?)',
      [prId, r.login, r.avatarUrl, r.state]
    );
  }
}

export async function insertComments(prId, comments) {
  if (!comments.length) return;
  await pool.execute('DELETE FROM pr_comments WHERE pr_id = ?', [prId]);
  for (const c of comments) {
    await pool.execute(
      'INSERT INTO pr_comments (pr_id, author_login, author_avatar_url, body, created_at, path, comment_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [prId, c.login, c.avatarUrl, c.body, toMySQLDatetime(c.createdAt), c.path || null, c.type]
    );
  }
}

export async function insertFiles(prId, files) {
  if (!files.length) return;
  await pool.execute('DELETE FROM pr_files WHERE pr_id = ?', [prId]);
  for (const f of files) {
    await pool.execute(
      'INSERT INTO pr_files (pr_id, path) VALUES (?, ?)',
      [prId, f]
    );
  }
}

export async function getPRs(repos, since, until) {
  if (!repos || repos.length === 0) {
    const [rows] = await pool.query(
      `SELECT * FROM pull_requests WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC`,
      [since, until]
    );
    return rows;
  }
  const placeholders = repos.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT * FROM pull_requests WHERE repo IN (${placeholders}) AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC`,
    [...repos, since, until]
  );
  return rows;
}

export async function getReviewsForPRs(prIds) {
  if (!prIds.length) return [];
  const placeholders = prIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT * FROM pr_reviews WHERE pr_id IN (${placeholders})`,
    prIds
  );
  return rows;
}

export async function getCommentsForPRs(prIds) {
  if (!prIds.length) return [];
  const placeholders = prIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT * FROM pr_comments WHERE pr_id IN (${placeholders})`,
    prIds
  );
  return rows;
}

export async function getFilesForPRs(prIds) {
  if (!prIds.length) return [];
  const placeholders = prIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT * FROM pr_files WHERE pr_id IN (${placeholders})`,
    prIds
  );
  return rows;
}

export async function getCommentsByAuthor(repos, since, until, authorLogin) {
  if (!repos || repos.length === 0) {
    const [rows] = await pool.query(
      `SELECT c.*, p.number as pr_number, p.title as pr_title, p.author_login as pr_author, p.repo as pr_repo
       FROM pr_comments c
       JOIN pull_requests p ON c.pr_id = p.id
       WHERE p.created_at >= ? AND p.created_at <= ?
         AND c.author_login = ?
       ORDER BY c.created_at DESC`,
      [since, until, authorLogin]
    );
    return rows;
  }
  const placeholders = repos.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT c.*, p.number as pr_number, p.title as pr_title, p.author_login as pr_author, p.repo as pr_repo
     FROM pr_comments c
     JOIN pull_requests p ON c.pr_id = p.id
     WHERE p.repo IN (${placeholders})
       AND p.created_at >= ? AND p.created_at <= ?
       AND c.author_login = ?
     ORDER BY c.created_at DESC`,
    [...repos, since, until, authorLogin]
  );
  return rows;
}

export async function hasData(repos, since, until) {
  const placeholders = repos.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT COUNT(*) as cnt FROM pull_requests WHERE repo IN (${placeholders}) AND created_at >= ? AND created_at <= ?`,
    [...repos, since, until]
  );
  return rows[0].cnt > 0;
}

export { pool };
