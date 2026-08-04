# Water + BYOK — backend deploy

Frontend product docs (engines + **skills map**): [`docs/ENGINES.md`](https://github.com/dhanushyangal/hyd-f/blob/main/docs/ENGINES.md) · pipeline: [`docs/WATER_ORCHESTRATION.md`](https://github.com/dhanushyangal/hyd-f/blob/main/docs/WATER_ORCHESTRATION.md).

Water generate body: `skillId` (`object-studio` \| `character` \| `animation` \| `game` …) + `qualityTier` (`fast` \| `standard` \| `studio`). Runtime packs: `src/lib/water/skills/`.

## 1) Supabase SQL (do this first)

In Supabase → SQL Editor, run **in order**:

1. [`sql/add_user_api_keys_and_code_sculpt.sql`](./sql/add_user_api_keys_and_code_sculpt.sql)  
2. [`sql/add_cursor_provider.sql`](./sql/add_cursor_provider.sql) — allows `cursor` BYOK keys  
3. [`sql/005_water_llm_tokens.sql`](./sql/005_water_llm_tokens.sql) — `llm_*_tokens` on `jobs`  

Additive only — safe for existing mesh jobs.

Optional cleanup (invite teardown, if not already applied):

- [`sql/004_drop_unused_invite_and_columns.sql`](./sql/004_drop_unused_invite_and_columns.sql) — drops invite tables / `users.is_approved` / unused job columns  

Canonical schema reference: [`sql/schema.sql`](./sql/schema.sql) (post invite cleanup).

## 2) New Vercel env (backend project)

**Required for Water / BYOK:**

```bash
USER_API_KEYS_ENCRYPTION_SECRET=<openssl rand -hex 32>
```

Generate once, set in Vercel → Project → Settings → Environment Variables → Production (+ Preview if you use it).  
**Do not rotate** after users have saved keys (old ciphertext won’t decrypt).

Redeploy backend after setting.

**Already needed for uploads / Water thumbnails (should already be set):**

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
S3_BUCKET
S3_REGION
```

## 3) Routes mounted on Vercel

`api/index.ts` mounts:

- `/api/user` — API keys, model prefs  
  - `GET /api/user/openrouter/free-models` — live free catalog  
  - `GET /api/user/cursor/models` — live Cloud Agents models (needs Cursor key)  
- `/api/water` — Water Studio generate / poll / thumbnail / usage  
  - Body: `skillId`, `qualityTier` (defaults: `object-studio`, `standard`)  
- `/api/code-sculpt` — legacy alias (same router)  
- `/api/3d` — cloud mesh + workspaces + health  
- `/api/payments` — credits / subscriptions / Dodo webhook  

Invite and admin routers are **removed** (no `/api/invites`, `/api/admin`).

`maxDuration: 300` + `waitUntil` keep Water LLM work alive after the fast `jobId` response. Studio tier may return `partial: true` if the soft time budget is hit.

**Note:** Local `src/server.ts` also mounts `/api/dodo` and `/api/contact`, and runs background `syncAllJobs` for cloud GPU jobs. Vercel serverless does **not** run that background loop.

## 4) Engines

| | Hydrilla cloud (Trilles) | Water |
|---|---|---|
| Input | Image (or text→image→3D) | Text; image optional |
| Compute | Hydrilla GPU (`api.hydrilla.co`) | User LLM key (Claude / OpenAI / Gemini / OpenRouter / Cursor) |
| Cost | Credits | 0 credits |
| Output | GLB | Three.js factory + token usage on DONE |

Water model architecture: frontend `docs/ENGINES.md`.  
Do **not** call the cloud engine Aggregator.
