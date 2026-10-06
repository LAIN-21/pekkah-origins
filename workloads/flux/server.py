"""Warm image server for worker A (PLAN 7.2).

FLUX.1-schnell with the transformer and T5 in 4-bit NF4, everything on the GPU
(bf16 FLUX plus T5 would not fit the droplet's 32 GB of RAM for CPU offload).
One generation at a time. FLUX_MODEL=sdxl loads SDXL base 1.0 behind the same
API. No internet: weights come read-only from MODELS_DIR, HF_HUB_OFFLINE=1.

  GET  /health    {ready, model, vramUsedGb}
  POST /generate  {prompt, seed, size, steps} -> PNG bytes
"""

import io
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Literal

import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

MODEL = os.environ.get("FLUX_MODEL", "flux")
MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
SDXL_STEPS = 20
LOCK_WAIT_SEC = 120

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("flux")

state: dict = {"ready": False, "error": None, "pipe": None}
generate_lock = threading.Lock()


def load_pipeline():
    if MODEL == "flux":
        from diffusers import FluxPipeline
        from diffusers.quantizers import PipelineQuantizationConfig

        quant = PipelineQuantizationConfig(
            quant_backend="bitsandbytes_4bit",
            quant_kwargs={
                "load_in_4bit": True,
                "bnb_4bit_quant_type": "nf4",
                "bnb_4bit_compute_dtype": torch.bfloat16,
            },
            components_to_quantize=["transformer", "text_encoder_2"],
        )
        pipe = FluxPipeline.from_pretrained(
            MODELS_DIR, quantization_config=quant, torch_dtype=torch.bfloat16
        )
    elif MODEL == "sdxl":
        from diffusers import StableDiffusionXLPipeline

        pipe = StableDiffusionXLPipeline.from_pretrained(
            os.path.join(MODELS_DIR, "sdxl"),
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
    else:
        raise ValueError(f"FLUX_MODEL must be flux or sdxl, got {MODEL!r}")
    pipe = pipe.to("cuda")
    pipe.set_progress_bar_config(disable=True)
    return pipe


def render(prompt: str, seed: int, size: int, steps: int) -> bytes:
    pipe = state["pipe"]
    generator = torch.Generator("cpu").manual_seed(seed)
    try:
        if MODEL == "flux":
            # schnell is distilled for 1-4 steps without classifier-free guidance.
            out = pipe(
                prompt=prompt,
                height=size,
                width=size,
                num_inference_steps=steps,
                guidance_scale=0.0,
                max_sequence_length=256,
                generator=generator,
            )
        else:
            out = pipe(
                prompt=prompt,
                height=size,
                width=size,
                num_inference_steps=SDXL_STEPS,
                generator=generator,
            )
        buf = io.BytesIO()
        out.images[0].save(buf, format="PNG")
        return buf.getvalue()
    finally:
        # Hand the allocator's cached blocks back, so /health (and the worker's
        # GPU stats) report what the model holds, not the last generation's peak.
        torch.cuda.empty_cache()


def vram_used_gb() -> float | None:
    if not torch.cuda.is_available():
        return None
    free, total = torch.cuda.mem_get_info()
    return round((total - free) / 2**30, 2)


def warm_up() -> None:
    try:
        started = time.monotonic()
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        state["pipe"] = load_pipeline()
        loaded = time.monotonic()
        log.info("loaded %s in %.1f s, VRAM in use %.2f GiB", MODEL, loaded - started, vram_used_gb())
        render("warm-up", seed=0, size=512, steps=1)
        log.info("warm-up done in %.1f s", time.monotonic() - loaded)
        state["ready"] = True
    except Exception as exc:  # noqa: BLE001 - reported through /health and the log
        state["error"] = f"{type(exc).__name__}: {exc}"[:500]
        log.exception("loading %s failed", MODEL)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Load in the background so /health answers (ready: false) while it loads.
    threading.Thread(target=warm_up, name="warm-up", daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


class GenerateRequest(BaseModel):
    """Mirrors ImageParams in packages/protocol."""

    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    prompt: str = Field(min_length=1, max_length=300)
    seed: int = Field(ge=0, le=2**32 - 1)
    size: Literal[768, 1024]
    steps: int = Field(ge=1, le=4)


@app.get("/health")
def health() -> dict:
    body = {"ready": state["ready"], "model": MODEL, "vramUsedGb": vram_used_gb()}
    if state["error"]:
        body["error"] = state["error"]
    return body


@app.post("/generate")
def generate(req: GenerateRequest) -> Response:
    if not state["ready"]:
        raise HTTPException(status_code=503, detail="model not ready")
    if not generate_lock.acquire(timeout=LOCK_WAIT_SEC):
        raise HTTPException(status_code=503, detail="busy")
    try:
        started = time.monotonic()
        png = render(req.prompt, req.seed, req.size, req.steps)
        duration_ms = round((time.monotonic() - started) * 1000)
    except Exception as exc:  # noqa: BLE001 - the worker sees a 500 and fails the job
        log.exception("generation failed")
        raise HTTPException(status_code=500, detail=f"generation failed: {type(exc).__name__}") from exc
    finally:
        generate_lock.release()
    log.info("generated size=%d steps=%d seed=%d in %d ms", req.size, req.steps, req.seed, duration_ms)
    return Response(
        content=png,
        media_type="image/png",
        headers={"X-Duration-Ms": str(duration_ms), "X-Model": MODEL},
    )
