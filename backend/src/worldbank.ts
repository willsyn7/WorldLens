interface WorldBankCountryObject {
  id: string;
  iso2Code: string;
  name: string;
  region: { id: string; iso2code: string; value: string };
}

type WorldBankCountryResponse = [unknown, WorldBankCountryObject[] | null];

export interface ValidatedCountry {
  code: string;
  name: string;
}

// Direct call to the World Bank REST API - only used in the untracked-country
// path, to confirm a code is a real country (not just well-formed) before we
// create a row for it and kick off a gRPC fetch. Bulk indicator data always
// goes through ingest-service; this is the one lightweight exception.
export async function validateCountry(code: string): Promise<ValidatedCountry | null> {
  const response = await fetch(`https://api.worldbank.org/v2/country/${code}?format=json`);
  if (!response.ok) {
    throw new Error(`World Bank API request failed with status ${response.status}`);
  }

  const body = (await response.json()) as WorldBankCountryResponse;
  const [, countries] = body;
  if (!countries || countries.length === 0) {
    return null;
  }

  const country = countries[0];
  // region.id "NA" marks aggregates/regions (e.g. "East Asia & Pacific"),
  // not real countries.
  if (country.region.id === 'NA') {
    return null;
  }

  return { code: country.iso2Code, name: country.name };
}
