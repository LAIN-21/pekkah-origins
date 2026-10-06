# Warm image server for worker A (PLAN 7.2). Built on the GPU droplet by
# scripts/deploy.sh flux; runs on the internal pekkah-jobs network only.
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/tmp/hf

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY server.py fetch_weights.py ./

# The server runs as an unprivileged user; the weights are mounted read-only.
# flux-fetch overrides the user, since it writes the weights.
RUN id -u 1000 >/dev/null 2>&1 || useradd --uid 1000 --create-home flux
USER 1000:1000

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
