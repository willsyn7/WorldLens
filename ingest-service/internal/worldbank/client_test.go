package worldbank

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func newTestClient(baseURL string) *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 5 * time.Second},
		baseURL:    baseURL,
	}
}

func TestMain(m *testing.M) {
	retryBackoff = time.Millisecond // keep retry tests fast
	m.Run()
}

func TestStreamIndicator_SinglePageWithNullValue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// per_page unquoted here (matches the real World Bank API, which is
		// inconsistent about quoting this field) as a regression guard.
		fmt.Fprint(w, `[
			{"page":1,"pages":1,"per_page":1000,"total":2},
			[
				{"indicator":{"id":"NY.GDP.MKTP.CD","value":"GDP (current US$)"},
				 "country":{"id":"MM","value":"Myanmar"},
				 "countryiso3code":"MMR","date":"2022","value":65100000000},
				{"indicator":{"id":"NY.GDP.MKTP.CD","value":"GDP (current US$)"},
				 "country":{"id":"MM","value":"Myanmar"},
				 "countryiso3code":"MMR","date":"2021","value":null}
			]
		]`)
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	var records []IndicatorRecord
	err := client.StreamIndicator(context.Background(), "MM", "NY.GDP.MKTP.CD", 0, 0, func(r IndicatorRecord) error {
		records = append(records, r)
		return nil
	})
	if err != nil {
		t.Fatalf("StreamIndicator returned error: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("expected 2 records, got %d", len(records))
	}
	if records[0].Year != 2022 || !records[0].HasValue || records[0].Value != 65100000000 {
		t.Errorf("unexpected first record: %+v", records[0])
	}
	if records[1].Year != 2021 || records[1].HasValue {
		t.Errorf("expected second record to have no value, got: %+v", records[1])
	}
}

func TestStreamIndicator_Pagination(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		switch page {
		case "1", "":
			fmt.Fprint(w, `[
				{"page":1,"pages":2,"per_page":"1","total":2},
				[{"indicator":{"id":"IND","value":"Indicator"},"country":{"id":"MM","value":"Myanmar"},
				  "countryiso3code":"MMR","date":"2022","value":1}]
			]`)
		case "2":
			fmt.Fprint(w, `[
				{"page":2,"pages":2,"per_page":"1","total":2},
				[{"indicator":{"id":"IND","value":"Indicator"},"country":{"id":"MM","value":"Myanmar"},
				  "countryiso3code":"MMR","date":"2021","value":2}]
			]`)
		default:
			t.Fatalf("unexpected page requested: %s", page)
		}
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	var years []int32
	err := client.StreamIndicator(context.Background(), "MM", "IND", 0, 0, func(r IndicatorRecord) error {
		years = append(years, int32(r.Year))
		return nil
	})
	if err != nil {
		t.Fatalf("StreamIndicator returned error: %v", err)
	}
	if len(years) != 2 || years[0] != 2022 || years[1] != 2021 {
		t.Fatalf("expected records from both pages in order, got %v", years)
	}
}

func TestStreamIndicator_NullDataArray(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `[{"page":1,"pages":1,"per_page":"1000","total":0},null]`)
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	called := false
	err := client.StreamIndicator(context.Background(), "XX", "BOGUS", 0, 0, func(r IndicatorRecord) error {
		called = true
		return nil
	})
	if err != nil {
		t.Fatalf("StreamIndicator returned error: %v", err)
	}
	if called {
		t.Error("expected no records to be yielded for a null data array")
	}
}

func TestFetchPage_RetriesOn5xxThenSucceeds(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&hits, 1) <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, `[{"page":1,"pages":1,"per_page":"1000","total":0},[]]`)
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	_, err := client.fetchPage(context.Background(), "MM", "IND", 0, 0, 1)
	if err != nil {
		t.Fatalf("expected eventual success after retries, got error: %v", err)
	}
	if got := atomic.LoadInt32(&hits); got != 3 {
		t.Errorf("expected 3 attempts, got %d", got)
	}
}

func TestFetchPage_NoRetryOn4xx(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	_, err := client.fetchPage(context.Background(), "MM", "IND", 0, 0, 1)
	if err == nil {
		t.Fatal("expected an error for a 404 response")
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("expected exactly 1 attempt (no retry on 4xx), got %d", got)
	}
}

func TestFetchPage_ExhaustsRetriesOnPersistent5xx(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := newTestClient(server.URL)
	_, err := client.fetchPage(context.Background(), "MM", "IND", 0, 0, 1)
	if err == nil {
		t.Fatal("expected an error after exhausting retries")
	}
	if got := atomic.LoadInt32(&hits); got != maxAttempts {
		t.Errorf("expected %d attempts, got %d", maxAttempts, got)
	}
}
