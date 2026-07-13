// Package worldbank implements a client for the public World Bank
// indicator API (https://api.worldbank.org/v2). No API key is required.
package worldbank

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

const (
	defaultBaseURL = "https://api.worldbank.org/v2"

	// maxAttempts is the total number of tries for a single page fetch,
	// including the first attempt.
	maxAttempts = 4
)

// retryBackoff is a var (not const) so tests can shorten it.
var retryBackoff = 500 * time.Millisecond

// IndicatorRecord is one (country, indicator, year) observation.
type IndicatorRecord struct {
	CountryCode   string
	CountryName   string
	IndicatorCode string
	IndicatorName string
	Year          int
	Value         float64
	HasValue      bool
}

// Client fetches indicator data from the World Bank API.
type Client struct {
	httpClient *http.Client
	baseURL    string
}

// NewClient returns a Client using the public World Bank endpoint.
func NewClient() *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 15 * time.Second},
		baseURL:    defaultBaseURL,
	}
}

// wbEnvelope mirrors the [metadata, data] shape the World Bank API returns.
type wbEnvelope struct {
	Metadata wbMetadata
	Data     []wbDataPoint
}

// wbMetadata only captures the fields StreamIndicator needs to paginate.
// The World Bank API is inconsistent about whether per_page/total are
// quoted, so those unused fields are intentionally omitted rather than
// worked around.
type wbMetadata struct {
	Page  int `json:"page"`
	Pages int `json:"pages"`
}

type wbDataPoint struct {
	Indicator struct {
		ID    string `json:"id"`
		Value string `json:"value"`
	} `json:"indicator"`
	Country struct {
		ID    string `json:"id"`
		Value string `json:"value"`
	} `json:"country"`
	CountryISO3Code string   `json:"countryiso3code"`
	Date            string   `json:"date"`
	Value           *float64 `json:"value"`
}

// UnmarshalJSON handles the World Bank API's [metadata, data] top-level
// array shape, which doesn't map onto a normal Go struct.
func (e *wbEnvelope) UnmarshalJSON(b []byte) error {
	var raw [2]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return fmt.Errorf("worldbank: unexpected response shape: %w", err)
	}
	if err := json.Unmarshal(raw[0], &e.Metadata); err != nil {
		return fmt.Errorf("worldbank: decoding metadata: %w", err)
	}
	// When a country/indicator combination has no data, the World Bank
	// API returns `null` for the data element instead of an empty array.
	if string(raw[1]) == "null" {
		e.Data = nil
		return nil
	}
	if err := json.Unmarshal(raw[1], &e.Data); err != nil {
		return fmt.Errorf("worldbank: decoding data: %w", err)
	}
	return nil
}

// StreamIndicator fetches every page of data for one country/indicator
// pair and invokes yield for each record as soon as its page is decoded,
// so callers (e.g. a gRPC server) can forward records without buffering
// the whole result set in memory.
func (c *Client) StreamIndicator(ctx context.Context, countryCode, indicatorCode string, startYear, endYear int, yield func(IndicatorRecord) error) error {
	page := 1
	for {
		envelope, err := c.fetchPage(ctx, countryCode, indicatorCode, startYear, endYear, page)
		if err != nil {
			return err
		}

		for _, d := range envelope.Data {
			year, err := strconv.Atoi(d.Date)
			if err != nil {
				continue // skip malformed year entries rather than failing the whole stream
			}
			record := IndicatorRecord{
				CountryCode:   d.Country.ID,
				CountryName:   d.Country.Value,
				IndicatorCode: d.Indicator.ID,
				IndicatorName: d.Indicator.Value,
				Year:          year,
				HasValue:      d.Value != nil,
			}
			if d.Value != nil {
				record.Value = *d.Value
			}
			if err := yield(record); err != nil {
				return err
			}
		}

		if envelope.Metadata.Page >= envelope.Metadata.Pages {
			return nil
		}
		page++
	}
}

// fetchPage retries transient failures (network errors and 5xx responses)
// with a linear backoff, since the World Bank API occasionally times out
// or briefly 5xxs under load. 4xx responses (e.g. an invalid country or
// indicator code) are not retried, since retrying won't change the result.
func (c *Client) fetchPage(ctx context.Context, countryCode, indicatorCode string, startYear, endYear, page int) (*wbEnvelope, error) {
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			select {
			case <-time.After(retryBackoff * time.Duration(attempt-1)):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		envelope, retryable, err := c.doFetchPage(ctx, countryCode, indicatorCode, startYear, endYear, page)
		if err == nil {
			return envelope, nil
		}
		lastErr = err
		if !retryable {
			return nil, err
		}
	}
	return nil, fmt.Errorf("worldbank: giving up after %d attempts: %w", maxAttempts, lastErr)
}

// doFetchPage performs a single HTTP attempt. The returned bool reports
// whether the error, if any, is worth retrying.
func (c *Client) doFetchPage(ctx context.Context, countryCode, indicatorCode string, startYear, endYear, page int) (*wbEnvelope, bool, error) {
	url := fmt.Sprintf("%s/country/%s/indicator/%s?format=json&per_page=1000&page=%d",
		c.baseURL, countryCode, indicatorCode, page)
	if startYear != 0 && endYear != 0 {
		url += fmt.Sprintf("&date=%d:%d", startYear, endYear)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false, fmt.Errorf("worldbank: building request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, true, fmt.Errorf("worldbank: request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 500 {
		return nil, true, fmt.Errorf("worldbank: server error status %d for %s", resp.StatusCode, url)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("worldbank: unexpected status %d for %s", resp.StatusCode, url)
	}

	var envelope wbEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, false, fmt.Errorf("worldbank: decoding response from %s: %w", url, err)
	}
	return &envelope, false, nil
}
