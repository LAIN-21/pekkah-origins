"""Downloads the model weights once (compose profile `fetch`, the only flux
container with internet access). If the files are already there, this only
verifies them. Never logs the token."""

import os
import sys
import time

from huggingface_hub import snapshot_download

MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
MODEL = os.environ.get("FLUX_MODEL", "flux")

# FLUX: the diffusers folders only (about 34 GB). Skips the 23.8 GB single-file
# checkpoint and ae.safetensors at the repo root.
FLUX = {
    "repo_id": "black-forest-labs/FLUX.1-schnell",
    # The commit the weights on worker A came from: a later fetch never moves to a
    # newer upload, so a seed keeps giving the same image.
    "revision": "741f7c3ce8b383c54771c7003378a50191e9efe9",
    "local_dir": MODELS_DIR,
    "allow_patterns": [
        "model_index.json",
        "scheduler/*",
        "text_encoder/*",
        "text_encoder_2/*",
        "tokenizer/*",
        "tokenizer_2/*",
        "transformer/*",
        "vae/*",
    ],
}

# Fallback: SDXL base 1.0, fp16 files only (about 7 GB), in its own folder.
SDXL = {
    "repo_id": "stabilityai/stable-diffusion-xl-base-1.0",
    "revision": "462165984030d82259a11f4367a4eed129e94a7b",
    "local_dir": os.path.join(MODELS_DIR, "sdxl"),
    "allow_patterns": [
        "model_index.json",
        "scheduler/*",
        "tokenizer/*",
        "tokenizer_2/*",
        "*/config.json",
        "text_encoder/model.fp16.safetensors",
        "text_encoder_2/model.fp16.safetensors",
        "unet/diffusion_pytorch_model.fp16.safetensors",
        "vae/diffusion_pytorch_model.fp16.safetensors",
    ],
}


def main() -> int:
    spec = {"flux": FLUX, "sdxl": SDXL}.get(MODEL)
    if spec is None:
        print(f"FLUX_MODEL must be flux or sdxl, got {MODEL!r}", file=sys.stderr)
        return 2
    token = os.environ.get("HF_TOKEN") or None
    if token is None and MODEL == "flux":
        print("HF_TOKEN is missing (FLUX.1-schnell is gated)", file=sys.stderr)
        return 2
    started = time.monotonic()
    print(f"fetching {spec['repo_id']}@{spec['revision'][:7]} into {spec['local_dir']}", flush=True)
    path = snapshot_download(
        repo_id=spec["repo_id"],
        revision=spec["revision"],
        local_dir=spec["local_dir"],
        allow_patterns=spec["allow_patterns"],
        token=token,
    )
    print(f"done in {time.monotonic() - started:.0f} s: {path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
