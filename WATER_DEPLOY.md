# Water + BYOK — backend deploy

Frontend product docs: in the `hyd-f` repo → [`docs/ENGINES.md`](https://github.com/dhanushyangal/hyd-f/blob/main/docs/ENGINES.md).

## 1) Supabase SQL (do this first)

In Supabase → SQL Editor, run:

[`sql/add_user_api_keys_and_code_sculpt.sql`](./sql/add_user_api_keys_and_code_sculpt.sql)

Additive only — safe for existing mesh jobs. Creates `user_api_keys` / prefs and Water columns on `jobs`.

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

- `/api/user` — API keys, model prefs, OpenRouter free sync  
- `/api/water` — Water generate / poll / thumbnail  
- `/api/code-sculpt` — legacy alias (same router)  
- existing `/api/3d`, payments, invites, admin  

`maxDuration: 300` + `waitUntil` keep Water LLM work alive after the fast `jobId` response.

## 4) Engines

| | Hydrilla cloud (Trilles) | Water |
|---|---|---|
| Input | Image (or text→image→3D) | Text; image optional |
| Compute | Hydrilla GPU | User LLM key |
| Cost | Credits | 0 credits |
| Output | GLB | Three.js factory |

Do **not** call the cloud engine Aggregator.
