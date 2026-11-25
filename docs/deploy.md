# Deploying to the home lab

The app runs as one Docker container on a VM in Proxmox, reachable only over the tailnet.

## 1. Create the VM

- Debian 12 (or Ubuntu 24.04) VM or LXC on Proxmox. 1 vCPU and 1 GB RAM is plenty to start.
- Install Docker: `curl -fsSL https://get.docker.com | sh`
- Install Tailscale and join the tailnet: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`

## 2. Mount the books folder

Book files live on the NAS; the database stays on the VM's own disk (SQLite does not like network filesystems).

NFS example (`/etc/fstab`):

```
nas.local:/volume1/books  /mnt/nas/books  nfs  defaults,_netdev  0 0
```

SMB example:

```
//nas.local/books  /mnt/nas/books  cifs  credentials=/root/.smb-books,uid=1000,gid=1000,_netdev  0 0
```

Then `sudo mkdir -p /mnt/nas/books && sudo mount -a`.

Prefer object storage? Run MinIO (or Garage) and set `STORAGE_DRIVER=s3` plus the `S3_*` settings in `.env` instead.

## 3. Run the app

```sh
git clone https://github.com/OccupiedPorcupine/library.git && cd library
cp .env.example .env   # set BOOKS_PATH=/mnt/nas/books
docker compose up -d --build
```

The container listens on `127.0.0.1:8080` only.

## 4. Put it on the tailnet

```sh
sudo tailscale serve --bg 8080
```

The app is now at `https://<vm-name>.<tailnet>.ts.net` with a real HTTPS certificate (needed later for the PWA and offline mode), and is not reachable from the LAN or the internet.

Already have books in the folder? Import them with:

```sh
curl -X POST http://127.0.0.1:8080/api/library/scan
```

## Updating

```sh
git pull && docker compose up -d --build
```

## Backups

Back up `./data/library.db` (shelves, progress, metadata) along with the books folder. Covers are stored next to the books under `covers/` and can be regenerated.

> Login is not built yet (#11). Until then, keep it tailnet-only.
