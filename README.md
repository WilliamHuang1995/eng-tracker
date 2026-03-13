# Eng Tracker

A lightweight GitHub PR analytics dashboard for engineering managers.

## What it tracks

| Metric | Details |
|---|---|
| **PRs submitted** | Total + weekly average per engineer |
| **Merge time** | Avg, min, max (color coded: green <24h, yellow <72h, red >72h) |
| **Comments on others' PRs** | Total + weekly average — measures code review engagement |
| **Silent approvals** | Approvals with zero comments left — flags rubber-stamping |

## Setup

**Requirements:** Node.js 18+

```bash
cd eng-tracker/backend
npm install
npm start
```

Then open **http://localhost:3001**

## GitHub Token

Generate a Personal Access Token at https://github.com/settings/tokens

Required scopes: **repo** (for private repos) or **public_repo** (for public repos only)

Set it inside backend/.env

## Rate limits

GitHub allows **5,000 API requests/hour** with a token. Each PR requires ~3 API calls
(reviews + review comments + issue comments). For a repo with 200 PRs in 4 weeks,
that's ~600 requests — well within limits.

The backend caches results for **5 minutes** to avoid redundant calls on refresh.

## Project structure

```
eng-tracker/
├── backend/
│   ├── server.js        # Express server + GitHub API logic
│   └── package.json
└── frontend/
    └── index.html       # Single-page dashboard (Chart.js via CDN)
```
