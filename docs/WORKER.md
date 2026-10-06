# Run a Pekkah worker

Any Linux machine with Docker can join the Pekkah market with one command. This page says what the worker does, what you trust when you run it, what the market checks, and how a new worker starts selling.

Everything runs on Cardano preprod, paid in test tokens.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/LAIN-21/pekkah-origins/main/install.sh | sudo sh -s -- --payout addr_test1…
```

`--payout` is the preprod address that receives this worker's payments. The installer:

1. Checks for Linux and Docker. If Docker is missing, it prints the get.docker.com command and stops. It installs nothing silently.
2. Detects an NVIDIA GPU and the NVIDIA container runtime.
3. Pulls `ghcr.io/lain-21/pekkah-worker` and `ghcr.io/lain-21/pekkah-fractal`, then runs `probe` (below). If a check fails, it stops and installs nothing.
4. Writes `/etc/pekkah/worker.env` (mode 600): a `p-<6 hex>` id, job limits sized from the machine, the market URL, your payout address and the fractal image.
5. Starts the `pekkah-worker` container with `--restart unless-stopped`, the Docker socket and `/var/lib/pekkah`.
6. Waits until the market lists the worker and has checked its calibration, then prints the id it's listed under and the page link.

Options:

| Option | Default | What it does |
| --- | --- | --- |
| `--payout ADDR` | required | The preprod address this worker is paid to |
| `--market URL` | the hosted market | The market to join |
| `--id ID --token TOKEN` | none | An allowlisted id and its token: the worker sells |
| `--name NAME` | the id | A name for the worker. The market never shows it for a worker on probation |
| `--price USD` | 0.02 | The fractal price |
| `--cpus N`, `--memory 4g` | every vCPU, half the RAM up to 8g | The limits of each job container |
| `--uninstall` | | Removes the container, the env file, the data directory and the images |

Run it again to change a setting. It keeps the worker's id.

## What the worker does

The worker dials out to the market over a WebSocket (`wss://…/ws/worker`), so the machine needs no inbound port. It works behind NAT.

1. It sends a hello: its id, the hardware it detects, its payout address and its prices.
2. The market calibrates it (below).
3. It sends a heartbeat every 5 seconds with its CPU and GPU utilisation.
4. When the market sends a job, the worker runs it in a sandboxed container and sends back the result. A job runs only after the buyer's payment is verified, and the payment settles only after the result is delivered.

It runs two workloads, and nothing else: `fractal` (a CPU render) and `image` (FLUX images, only with the GPU path below).

If the market refuses the worker (`unauthorized` or `invalid_hello`), the worker prints why and stops instead of reconnecting. With `--restart unless-stopped`, Docker starts it again after a growing delay of up to a minute. The installer removes the container if that happens during the install.

## Trust model

- **The worker container is root on your machine.** It holds the Docker socket, and anything that holds the socket can start a privileged container. You trust the worker image as you would trust root. The images are built from this repo's `main` branch by `.github/workflows/publish.yml`, and the image's `org.opencontainers.image.revision` label is the commit it came from.
- **Jobs are the sandboxed part.** Every job container runs with `--network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory --cpus --user 1000:1000`, with only its own output directory mounted, and it's killed at its deadline plus 10 seconds. The market can only ask for the two whitelisted workloads, and the worker validates every parameter before it starts anything.
- **What the market learns about your machine:** the hello (CPU model, vCPUs, RAM, GPU name, VRAM, driver), utilisation in heartbeats, and the results of the jobs it sends.
- **Your token**, if you have one, lives only in `/etc/pekkah/worker.env`, which only root can read.

## What the machine reports, and what the market measures

**Reported by the machine:** hardware. The market stores the hello as sent, with every string cut to a fixed length. A buyer's GPU and VRAM constraints are checked against these values, so they are only as honest as the machine.

**Measured by the market:** speed. On every connect, the market sends calibration jobs and times them:

- `tiny`, twice: the fixed cost of a job.
- `calib`: one of 8 views, picked at random. The sha256 of the answer must equal the reference committed in `packages/protocol`.
- `hd-fast`: a real render that sets the speed. Its answer is checked too.

A wrong answer marks the worker untrusted, and the matcher skips it. Image speed is one timed generation, not checked. The fractal code uses integer arithmetic, so the answers are the same on every CPU.

`probe` runs the same calibration jobs on your machine, against the same references, before it joins:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v /var/lib/pekkah:/var/lib/pekkah \
  ghcr.io/lain-21/pekkah-worker:latest pnpm probe
```

Add `--gpus all` on a GPU machine. It prints the machine card, runs the checks, runs `nvidia-smi` in a `--gpus all` container when there's a GPU, and exits non-zero if a check fails.

## Probation, and how a worker starts selling

A worker without a token joins **on probation**, on a market where open join is on (the hosted market has it on):

- It's listed under an id the market gives it, `joining-` plus 6 hex characters, never under the name it sent.
- It's calibrated like any worker, and the page shows its reported hardware and measured speed.
- It **sells nothing**. The matcher never offers it, it never gets a paid job, and it's never paid. It's removed from the list when it disconnects.

To sell, a worker needs an id on the market's allowlist and its token. I run the hosted market: I add an id and a token to its allowlist and send them to the operator, who runs the installer again with `--id` and `--token`. A known id with the wrong token is refused.

## GPU path (FLUX images, by hand)

On a machine with an NVIDIA GPU of at least 16 GB, the NVIDIA driver and the NVIDIA Container Toolkit, with about 40 GB free in `/var/lib`:

1. Install the worker as above. The installer sees the GPU and starts the worker with `--gpus all`, so the market lists the GPU.
2. Build the FLUX server and create its internal network (no internet):

   ```bash
   git clone https://github.com/LAIN-21/pekkah-origins && cd pekkah-origins
   sudo docker build -t pekkah/flux:local workloads/flux
   sudo docker network create --internal pekkah-jobs
   ```

3. Download the weights once (about 34 GB). FLUX.1-schnell is gated on Hugging Face, so this needs a read token. `read -rs` keeps it off the screen and out of the shell history:

   ```bash
   read -rs HF_TOKEN && export HF_TOKEN
   sudo mkdir -p /var/lib/pekkah/hf
   sudo -E docker run --rm --user 0:0 -e HF_TOKEN -e MODELS_DIR=/models \
     -v /var/lib/pekkah/hf:/models pekkah/flux:local python fetch_weights.py
   unset HF_TOKEN
   ```

4. Start the warm server, offline, on the internal network:

   ```bash
   sudo docker run -d --name pekkah-flux --restart unless-stopped --gpus all \
     --network pekkah-jobs --network-alias flux \
     -e HF_HUB_OFFLINE=1 -e MODELS_DIR=/models -v /var/lib/pekkah/hf:/models:ro pekkah/flux:local
   ```

   It's ready when `docker logs pekkah-flux` shows `warm-up done` (a minute or two).

5. Tell the worker about it, then run the installer again. It keeps these two lines and connects the worker to `pekkah-jobs`:

   ```bash
   printf 'FLUX_URL=http://flux:8000\nPRICE_IMAGE_USD=0.05\n' | sudo tee -a /etc/pekkah/worker.env
   curl -fsSL https://raw.githubusercontent.com/LAIN-21/pekkah-origins/main/install.sh | sudo sh -s -- --payout addr_test1…
   ```

The worker offers `image` only while FLUX answers ready. The market then times one generation. On probation, the image workload is listed and timed but never sold.

`--uninstall` doesn't remove `pekkah-flux`, `pekkah/flux:local` or the `pekkah-jobs` network. Remove them with `docker rm -f pekkah-flux`, `docker rmi pekkah/flux:local` and `docker network rm pekkah-jobs`, before `--uninstall` (which deletes `/var/lib/pekkah`, weights included).

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/LAIN-21/pekkah-origins/main/install.sh | sudo sh -s -- --uninstall
```

It removes the `pekkah-worker` container and any job container, `/etc/pekkah/worker.env`, `/var/lib/pekkah` (only if the installer created it) and both images.

## Without the published images

If the images can't be pulled, build them from the repo and point the installer at them:

```bash
git clone https://github.com/LAIN-21/pekkah-origins && cd pekkah-origins
sudo docker build --target worker -t pekkah/worker:local .
sudo docker build -t pekkah/fractal:local workloads/fractal
sudo sh install.sh --payout addr_test1… --worker-image pekkah/worker:local --fractal-image pekkah/fractal:local
```

## When something goes wrong

- `docker logs pekkah-worker` shows the worker's log. A refusal is one plain line, with what to fix.
- `the probe failed`: the probe's output names the check. Without the Docker socket, every check fails. A wrong calibration answer means the job image or the CPU gives different results, and the market would mark the worker untrusted.
- `not listed and calibrated after 3 minutes`: check that the machine reaches the market (`curl -fsS <market>/api/health`) and that open join is on there.
- `install.sh` won't run on a host with `/opt/pekkah`: that's one of my deployed workers, and the installer leaves it alone.
