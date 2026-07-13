# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
COPY etl/pyproject.toml ./
COPY etl/src/ ./src/
RUN pip install --no-cache-dir .
ENTRYPOINT ["python", "-m", "worldlens_etl.main"]
