# DockerDash

A minimal Docker dashboard. Lists containers (running/exited), shows live per-container stats, mapped ports, and lets you Start/Restart/Stop. All live updates use WebSockets.
<img width="1232" height="468" alt="Opera Snapshot_2025-09-16_124500_dock skyecord app" src="https://github.com/user-attachments/assets/afaf47ed-25a2-42f1-b5eb-271b6f351303" />

## Features
- Containers list (running + exited)
- Live state/ports (WS)
- Live per-container stats (CPU, Memory used, Net Up/Down, Disk R/W) (WS)
- Actions: Start / Restart / Stop

## Requirements
- Docker installed
- Compose mounts `/var/run/docker.sock`
- Port 8080 open (configurable)

## Quick start
1. Create `.env` from the example:
   ```bash
   cp example.env .env
   # edit PASSWORD and JWT_SECRET
   ```
2. Build and run:
   ```bash![Uploading Opera Snapshot_2025-09-16_124500_dock.skyecord.app.png…]()

   docker compose build --no-cache
   docker compose up -d
   ```
3. Open http://localhost:8080 and log in with your password.

## Live updates
- Containers WS: `/ws/containers/stream`
- Stats WS: `/ws/containers/:id/stats`
Ensure your proxy/CDN allows WebSocket upgrades for these paths.

## API (used by the UI)
- `POST /api/login` → `{ token }`
- `GET /api/containers`
- `POST /api/containers/:id/{start|stop|restart}`
- `GET /api/containers/:id/inspect` (for ports)
Header for authenticated calls: `Authorization: Bearer <token>`

## Development
- Frontend: `frontend/src/App.jsx` (single file UI)
- Backend: Express in `backend/app/*`
- Dockerfile builds both; no local Node required

### Clean rebuild
```bash
rm -rf backend/node_modules frontend/node_modules
docker compose build --no-cache
docker compose up -d
```

## Security notes
- Dashboard needs Docker socket access; restrict network access to the dashboard.
- Keep `JWT_SECRET` private.

License: GPL-2.0-only
