# Hosting runbook

How the library is hosted on the home lab, written so the same steps work for the next project.

The short version:

```
browser ──HTTPS──> Cloudflare (Access login) ──tunnel──> cloudflared ─┐
                                                                       ├─> Docker container :8080
phone/laptop on tailnet ──HTTPS──> tailscale serve ────────────────────┘
                                   (all inside one LXC container "library" on a Proxmox host)
```

Nothing on the home network is opened to the internet. Both paths are outbound connections from the container.

## The pieces, in plain words

| Piece | What it does |
| --- | --- |
| **Proxmox** | The machine that runs all the home lab "computers". |
| **LXC container** | A lightweight Linux box inside Proxmox. Shares Proxmox's kernel, so it starts in seconds and uses little memory. A VM is the heavier alternative. |
| **Docker Compose** | Builds the app into an image and runs it, restarting it if it crashes. Config is `docker-compose.yml`. |
| **Tailscale** | A private network between your own devices. `tailscale serve` gives the app an HTTPS address only your devices can reach. |
| **Cloudflare Tunnel** | `cloudflared` runs in the container and dials out to Cloudflare, so the public domain reaches the app without port forwarding. |
| **Cloudflare Access** | A login page Cloudflare shows before anyone reaches the app. Needed because the app has no login of its own yet. |
| **DNS** | `library.example.com` points at the tunnel. Cloudflare creates this record when you add the tunnel's public hostname. |

## 1. Create the container (Proxmox)

On the Proxmox host (`ssh root@<proxmox-host>`):

```sh
pvesh get /cluster/nextid            # next free ID, use it as <ID> below
pveam list local                     # templates already downloaded

pct create <ID> local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst \
  --hostname library --cores 2 --memory 2048 --swap 512 \
  --rootfs local:16 \
  --mp0 local:32,mp=/srv/books,backup=1 \
  --net0 name=eth0,bridge=vmbr0,gw=<gateway-ip>,ip=<container-ip>/24 \
  --nameserver "1.1.1.1 9.9.9.9" \
  --features nesting=1,keyctl=1 --unprivileged 1 --onboot 1
```

- `nesting=1,keyctl=1` lets Docker run inside the container.
- `--mp0` is a separate disk for the book files, so the system disk can be rebuilt without touching them.
- Use the same bridge and subnet as your other guests.

Tailscale needs the TUN device, so add these two lines to `/etc/pve/lxc/<ID>.conf` before starting:

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

Start it and get a shell inside:

```sh
pct start <ID>
pct enter <ID>
```

The container has no root password; `pct enter` from the Proxmox shell is how you get in.

## 2. Install Docker, Tailscale and cloudflared

Install each from its official signed apt repository (avoid `curl | sh` installers):

```sh
apt-get update && apt-get install -y curl git ca-certificates gnupg
install -m 0755 -d /etc/apt/keyrings

# Docker
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
  > /etc/apt/sources.list.d/docker.list

# Tailscale
curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
  -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
  -o /etc/apt/sources.list.d/tailscale.list

# cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  > /etc/apt/sources.list.d/cloudflared.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  tailscale cloudflared

docker run --rm hello-world          # proves Docker works inside the LXC
```

`trixie` is Debian 13. Use `bookworm` on Debian 12.

## 3. Run the app

```sh
cd /opt
git clone https://github.com/OccupiedPorcupine/library.git && cd library
cp .env.example .env
sed -i 's#^BOOKS_PATH=.*#BOOKS_PATH=/srv/books#' .env
docker compose up -d --build

curl http://127.0.0.1:8080/api/health   # {"ok":true,...}
```

The app only listens on `127.0.0.1:8080` inside the container. Tailscale and the tunnel are the only ways in.

Update later with:

```sh
cd /opt/library && git pull && docker compose up -d --build
```

## 4. Private access over Tailscale

```sh
tailscale up --hostname=library      # prints a login URL: open it and approve the machine
tailscale serve --bg 8080
```

The app is now at `https://library.<your-tailnet>.ts.net`, with a real certificate, for your own devices only.

If a device can't open it, check that device's Tailscale is connected (`tailscale status`). Some networks block Tailscale.

## 5. Public access with Cloudflare

Do the login (Access) **before** the tunnel's public hostname, so the site is never public without a login.

### 5a. Access login

Cloudflare dashboard → **Zero Trust → Access → Applications → Add an application → Self-hosted**:

- Domain: `library.example.com`
- Policy: **Allow**, Include → **Emails** → your email
- One-time PIN login works without any extra setup.

### 5b. Tunnel

**Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**, name it after the app:

1. On the install screen pick **Debian** and copy only the `cloudflared service install <token>` command. That token is a secret: don't paste it into chats, docs or git.
2. Run it inside the container (`pct enter <ID>`, drop the `sudo`). The connector turns **Connected**.
3. **Public hostname**: subdomain `library`, domain `example.com` (your domain), type `HTTP`, URL `localhost:8080`. Save. Cloudflare creates the DNS record.

Check from any browser: `https://library.example.com` should show the Cloudflare login first, then the app.

## Reusing this for a new project

1. New LXC with the next free ID (step 1), sized for the app.
2. Install Docker, Tailscale, cloudflared (step 2).
3. Run the app with Docker Compose bound to `127.0.0.1:<port>` (step 3).
4. `tailscale up` + `tailscale serve --bg <port>` (step 4).
5. Access app first, then a new tunnel and public hostname (step 5).

## Where things are

| What | Where |
| --- | --- |
| App code and `.env` | `/opt/library` in the container |
| Database | `/opt/library/data/library.db` |
| Book files | `/srv/books` in the container (separate Proxmox volume) |
| Tunnel config | Cloudflare dashboard (Zero Trust → Networks → Tunnels) |
| Login rules | Cloudflare dashboard (Zero Trust → Access → Applications) |

## Secrets

The repo is public. `.env`, `*.pem`, `*.key`, `.cloudflared/` and cloudflared credential files are gitignored. Never put tokens, tunnel commands or keys in this repo, including in docs.
