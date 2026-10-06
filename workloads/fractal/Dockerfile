# The CPU job image. Pinned by digest so every worker builds the same bytes (numpy, CPython's
# zlib), which the answer-checked calibration and cross-machine sha256 checks rely on.
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY fractal ./fractal
COPY tests ./tests

# Jobs run as 1000:1000 with a read-only root, no network and /out as the only writable mount.
USER 1000:1000
ENTRYPOINT ["python", "-m", "fractal"]
