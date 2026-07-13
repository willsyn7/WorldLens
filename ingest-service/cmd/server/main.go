package main

import (
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	worldbankpb "worldlens/ingest-service/internal/gen/worldbank/v1"
	"worldlens/ingest-service/internal/grpcserver"
	"worldlens/ingest-service/internal/worldbank"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "50051"
	}

	lis, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Fatalf("failed to listen on port %s: %v", port, err)
	}

	grpcServer := grpc.NewServer()

	client := worldbank.NewClient()
	worldbankpb.RegisterCountryDataServiceServer(grpcServer, grpcserver.New(client))

	healthServer := health.NewServer()
	healthpb.RegisterHealthServer(grpcServer, healthServer)
	healthServer.SetServingStatus("worldbank.v1.CountryDataService", healthpb.HealthCheckResponse_SERVING)

	reflection.Register(grpcServer)

	go func() {
		log.Printf("ingest-service listening on :%s", port)
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatalf("grpc server stopped serving: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("shutting down ingest-service...")
	grpcServer.GracefulStop()
}
