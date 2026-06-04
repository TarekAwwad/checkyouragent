FROM python:3.11-slim AS runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV CCFR_DATA_DIR=/app/data
ENV CCFR_DB_PATH=/app/data/ccfr.sqlite3
ENV CCFR_IMPORT_ROOT=/imports
ENV PYTHONPATH=/app/backend/src
COPY backend ./backend
# Pricing lives at the repo root; default pricing_path() resolves to /app/pricing.csv.
COPY pricing.csv ./pricing.csv
RUN pip install --no-cache-dir ./backend
EXPOSE 8000
CMD ["uvicorn", "ccfr.main:app", "--host", "0.0.0.0", "--port", "8000"]
