// Package grpcserver implements the CountryDataService gRPC contract by
// pulling data from the World Bank client and forwarding it to the caller
// as a stream.
package grpcserver

import (
	"fmt"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	worldbankpb "worldlens/ingest-service/internal/gen/worldbank/v1"
	"worldlens/ingest-service/internal/worldbank"
)

// Server implements worldbankpb.CountryDataServiceServer.
type Server struct {
	worldbankpb.UnimplementedCountryDataServiceServer
	client *worldbank.Client
}

// New returns a Server backed by the given World Bank client.
func New(client *worldbank.Client) *Server {
	return &Server{client: client}
}

// StreamCountryIndicators streams one IndicatorDataPoint per (indicator,
// year) observation for the requested country, fetching indicators one at
// a time and forwarding each record as soon as it's decoded.
func (s *Server) StreamCountryIndicators(req *worldbankpb.IndicatorRequest, stream worldbankpb.CountryDataService_StreamCountryIndicatorsServer) error {
	if req.GetCountryCode() == "" {
		return status.Error(codes.InvalidArgument, "country_code is required")
	}
	if len(req.GetIndicatorCodes()) == 0 {
		return status.Error(codes.InvalidArgument, "at least one indicator_code is required")
	}

	ctx := stream.Context()
	for _, indicatorCode := range req.GetIndicatorCodes() {
		err := s.client.StreamIndicator(ctx, req.GetCountryCode(), indicatorCode, int(req.GetStartYear()), int(req.GetEndYear()), func(record worldbank.IndicatorRecord) error {
			return stream.Send(&worldbankpb.IndicatorDataPoint{
				CountryCode:   record.CountryCode,
				CountryName:   record.CountryName,
				IndicatorCode: record.IndicatorCode,
				IndicatorName: record.IndicatorName,
				Year:          int32(record.Year),
				Value:         record.Value,
				HasValue:      record.HasValue,
			})
		})
		if err != nil {
			return status.Error(codes.Internal, fmt.Sprintf("fetching indicator %s: %v", indicatorCode, err))
		}
	}
	return nil
}
