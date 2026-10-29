FROM python:3.11-slim@sha256:e031123e3d85762b141ad1cbc56452ba69c6e722ebf2f042cc0dc86c47c0d8b3 AS runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV CCFR_DATA_DIR=/app/data
ENV CCFR_DB_PATH=/app/data/ccfr.sqlite3
ENV CCFR_IMPORT_ROOT=/imports
ENV PYTHONPATH=/app/backend/src
COPY backend ./backend
# Install only the dependency set pinned in uv.lock (hash-checked); a bare
# `pip install ./backend` would re-resolve the open-ended ranges in
# pyproject.toml at build time, and even with --no-deps its isolated build
# environment would pull an unpinned hatchling from PyPI. The package itself
# is never installed: the app runs from the copied source via PYTHONPATH, and
# config.app_version() reads backend/pyproject.toml in this layout.
RUN pip install --no-cache-dir uv==0.7.2 \
    && uv export --frozen --no-dev --no-emit-project \
        --directory backend --output-file /tmp/requirements.txt \
    && pip install --no-cache-dir --requirement /tmp/requirements.txt \
    && pip uninstall --yes uv \
    && rm /tmp/requirements.txt
# Data assets live at the repo root; the image mirrors the checkout layout, so
# the defaults resolve to /app/pricing.csv and /app/demo/claude-export ("Load
# demo data" / `serve --demo`). Copied after the pip install so data edits
# don't invalidate the dependency layer. Bundle dated history too; compose can
# still mount ./pricing:/app/pricing for runtime updates without a rebuild.
COPY pricing.csv ./pricing.csv
COPY pricing ./pricing
COPY demo/claude-export ./demo/claude-export
EXPOSE 8000
CMD ["uvicorn", "ccfr.main:app", "--host", "0.0.0.0", "--port", "8000"]
