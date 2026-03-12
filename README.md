# DockerDash (Open Source)

DockerDash is a small Docker control panel focused on real-time status and low overhead.

It is independent software and is not affiliated with Docker, Inc.

<img width="2512" height="1330" alt="DockerDash screenshot" src="https://github.com/user-attachments/assets/198a2975-0d5a-4aaf-9480-4fff40eb7bcb" />

## Why It Exists

When I just need to quickly check health, resource usage, or restart a container, full platform dashboards feel heavy.

DockerDash keeps it simple:

- container list
- live stats
- one-click actions
- minimal RAM/CPU footprint

## Features

- Live container list (running + exited)
- Ports shown per container
- Per-container realtime metrics:
  - CPU
  - memory
  - network up/down
  - disk read/write
- Aggregate "All Dockers" card
- Start / Restart / Stop / Kill actions
- JWT-based login
- WebSocket streams for updates

## Quick Start

```bash
git clone https://github.com/SkyeVoyant/DockerDash.git
cd dockerdash
cp example.env .env
# set PASSWORD + JWT_SECRET
docker compose build --no-cache
docker compose up -d
```

Open `http://localhost:8080`.

## Configuration

`.env` options:

- `PASSWORD`: dashboard login password
- `JWT_SECRET`: auth signing secret
- `PORT` (default `8080`)

## API / Streams

### REST

- `POST /api/login`
- `GET /api/containers`
- `GET /api/containers/:id/inspect`
- `POST /api/containers/:id/start`
- `POST /api/containers/:id/stop`
- `POST /api/containers/:id/restart`
- `POST /api/containers/:id/kill`

### WebSocket

- `/ws/containers/stream` (container snapshots)
- `/ws/containers/all/stats` (aggregate metrics)
- `/ws/containers/stats/stream` (single stream for all container samples)

## Behavior Notes

- Cards are sorted by container display name.
- "All Dockers" control actions skip DockerDash itself to avoid self-stop loops.
- Container inspect metadata is cached with TTL and pruned to avoid unbounded memory growth over long runtimes.

## Troubleshooting

- Connection issues:
  - `docker compose logs -f`
  - `docker logs -f <container>`
- Zero stats usually means Docker socket/mount issues.
- Behind proxy/CDN: allow WebSocket upgrade headers.

## Security Notes

- This service talks directly to `/var/run/docker.sock`.
- Keep it on trusted networks.
- Use reverse proxy + TLS + firewall rules when exposed remotely.

## Dev Paths

- Backend: `backend/app/server.js`
- Container cache/store: `backend/app/services/containersStore.js`
- Stats engine: `backend/app/services/statsStore.js`
- Frontend: `frontend/src/App.jsx`

## License

GPL-2.0-only
