# DockerDash (Open Source)

An independent dashboard for managing Docker containers.  
Not affiliated with or endorsed by Docker, Inc.

Minimal, real‑time Docker dashboard. See running/exited containers, mapped ports, and live stats; start/restart/stop containers in one click. Uses WebSockets end‑to‑end for instant updates. Designed to be tiny: just ~50 MB of RAM and negligible CPU overhead.
<img width="2512" height="1330" alt="Opera Snapshot_2025-09-18_054051_dock skyecord app" src="https://github.com/user-attachments/assets/198a2975-0d5a-4aaf-9480-4fff40eb7bcb" />


Pinned at the top is an “All Dockers” card showing aggregate CPU/Mem/Net/Disk, the Docker engine version, and the host Linux uptime. You can start/restart/stop all containers from there.

## Features
- Containers list (running + exited)
- Ports shown next to each container name
- Live per‑container stats (CPU, memory used, networking up/down, disk read/write) via WS
- “All Dockers” aggregate stats (includes DockerDash), engine version, host uptime via WS
- Actions: Start / Restart / Stop; Stop becomes Kill during start/restart phases
- Buttons disable contextually while actions are in progress

## Prerequisites
- Docker Engine (Linux recommended; WSL2 works)
- Docker Compose v2
- Port 8080 available (configurable via `.env`)

## Quick start
1) Get the code and configure
```bash
# Clone or download
git clone https://github.com/SkyeVoyant/DockerDash.git
cd dockerdash

# Create your env file
cp example.env .env

# Set a strong password and JWT secret
# Choose one of the following to generate a secret:
openssl rand -hex 32
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
python3 - <<'PY'
import os, binascii; print(binascii.hexlify(os.urandom(32)).decode())
PY
```

2) Build and run
```bash
docker compose build --no-cache
docker compose up -d
```

3) Open the dashboard
```
http://localhost:8080
```
Log in with the password you set in `.env`.

## Configuration
`.env` options:
- `PASSWORD`: login password for the dashboard
- `JWT_SECRET`: random secret string for auth tokens
- `PORT` (optional, default `8080`): port exposed by the container

## Usage notes
- Each container card shows state plus time since event: “up 3m 12s” (running) or “down 10s” (stopped), using Docker’s `StartedAt`/`FinishedAt`.
- The Stop button becomes Kill when a container is in a starting/restarting phase.
- “All Dockers” actions skip DockerDash itself (to avoid self‑termination), but aggregate stats include DockerDash so totals match what you see.

### Container display names
- DockerDash uses the container's `container_name` (from `docker-compose.yml` or `docker run --name`) as the title shown on each card.
- If `container_name` is not set, it falls back to the first name Docker reports (similar to `docker ps`).
- To customize how a container appears in the dashboard, set an explicit `container_name` in your compose file.

### Sorting
- Containers are ordered alphabetically by the displayed name in the UI (client‑side). “All Dockers” is pinned at the top.

## Real‑time endpoints (WebSocket)
- Containers stream: `/ws/containers/stream`
- Per‑container stats: `/ws/containers/:id/stats`
- Aggregate stats: `/ws/containers/all/stats`

If you run behind a proxy/CDN, make sure WebSocket upgrade is allowed for these paths.

## REST API (used by the UI)
- `POST /api/login` → `{ token }`
- `GET /api/containers`
- `GET /api/containers/:id/inspect` (for ports)
- `POST /api/containers/:id/{start|stop|restart}`
- `POST /api/containers/:id/kill` (used to abort mid start/restart)

Auth header: `Authorization: Bearer <token>`

## Reverse proxy quick tip (Nginx)
Enable WS upgrade and pass all paths:
```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

## Troubleshooting
- Can’t connect: `docker compose logs -f` and `docker logs -f dockerdash-app-1`
- Stats are zero: ensure `/var/run/docker.sock` is mounted (see compose) and Docker is running
- Behind Cloudflare/other CDNs: enable WebSockets and avoid buffering; development mode helps during setup

## Development
- Frontend: `frontend/src/App.jsx` (single‑file UI)
- Backend: Express in `backend/app/*`
- Build and run in Docker; local Node setup not required

Clean rebuild:
```bash
rm -rf backend/node_modules frontend/node_modules
docker compose build --no-cache && docker compose up -d
```

## Security
This app talks to the Docker daemon via the Unix socket. Expose the dashboard only to trusted networks, keep `JWT_SECRET` private, and put a reverse proxy or firewall in front when deployed on the internet.

## License
GPL-2.0-only
