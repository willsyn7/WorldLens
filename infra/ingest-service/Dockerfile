# syntax=docker/dockerfile:1
FROM golang:1.25 AS build
WORKDIR /src
COPY ingest-service/go.mod ingest-service/go.sum ./
RUN go mod download
COPY ingest-service/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/ingest-service ./cmd/server

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/ingest-service /ingest-service
EXPOSE 50051
ENTRYPOINT ["/ingest-service"]
