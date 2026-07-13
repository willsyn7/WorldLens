import { Router } from 'express';
import {
  pool,
  insertCountryIfMissing,
  getTrackedIndicators,
  upsertObservations,
} from '../db.js';
import { generateAnalysis } from '../vertex.js';
import { buildV1Prompt, type IndicatorObservation } from '../prompt.js';
import { DatabaseError, VertexError, WorldBankError } from '../errors.js';
import { validateCountry } from '../worldbank.js';
import { fetchIndicatorsForCountry } from '../grpcClient.js';

export const countryRouterV1 = Router();

countryRouterV1.get('/api/v1/country/:code', async (req, res, next) => {
  const code = req.params.code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    res.status(400).json({ error: `'${req.params.code}' is not a valid ISO alpha-2 country code` });
    return;
  }

  let countryResult;
  try {
    countryResult = await pool.query<{ code: string; name: string }>(
      'SELECT code, name FROM countries WHERE code = $1',
      [code],
    );
  } catch (err) {
    next(new DatabaseError('failed to query countries', err));
    return;
  }

  let country: { code: string; name: string };

  if (countryResult.rowCount === 0) {
    // Not tracked yet - validate against the World Bank API and, if it's a
    // real country, ingest it on demand rather than a flat 404.
    let validated;
    try {
      validated = await validateCountry(code);
    } catch (err) {
      next(new WorldBankError('failed to validate country against World Bank API', err));
      return;
    }

    if (!validated) {
      res.status(404).json({ error: `'${code}' is not a real country` });
      return;
    }

    try {
      await insertCountryIfMissing(validated.code, validated.name);
    } catch (err) {
      next(new DatabaseError('failed to insert new country', err));
      return;
    }

    let indicators;
    try {
      indicators = await getTrackedIndicators();
    } catch (err) {
      next(new DatabaseError('failed to load tracked indicators', err));
      return;
    }

    const dataPoints = await fetchIndicatorsForCountry(
      validated.code,
      indicators.map((i) => i.code),
    );

    if (dataPoints.length > 0) {
      try {
        await upsertObservations(
          dataPoints.map((p) => ({
            country_code: p.country_code,
            indicator_code: p.indicator_code,
            year: p.year,
            value: p.has_value ? p.value : null,
            has_value: p.has_value,
          })),
        );
      } catch (err) {
        next(new DatabaseError('failed to upsert fetched observations', err));
        return;
      }
    }

    country = validated;
  } else {
    country = countryResult.rows[0];
  }

  let observationsResult;
  try {
    observationsResult = await pool.query<IndicatorObservation>(
      `SELECT io.indicator_code, i.name AS indicator_name, io.year, io.value
       FROM indicator_observations io
       JOIN indicators i ON i.code = io.indicator_code
       WHERE io.country_code = $1 AND io.has_value = true
       ORDER BY io.indicator_code, io.year`,
      [country.code],
    );
  } catch (err) {
    next(new DatabaseError('failed to query indicator_observations', err));
    return;
  }

  const prompt = buildV1Prompt(country.name, observationsResult.rows);

  let analysis: string;
  try {
    analysis = await generateAnalysis(prompt);
  } catch (err) {
    next(new VertexError('vertex generateContent call failed', err));
    return;
  }

  res.json({
    country_code: country.code,
    country_name: country.name,
    analysis,
  });
});
