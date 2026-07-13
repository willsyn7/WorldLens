import { Router } from 'express';
import { pool } from '../db.js';
import { generateAnalysis } from '../vertex.js';
import { buildV1Prompt, type IndicatorObservation } from '../prompt.js';
import { DatabaseError, VertexError } from '../errors.js';

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

  if (countryResult.rowCount === 0) {
    res.status(404).json({ error: `Country '${code}' not found` });
    return;
  }
  const country = countryResult.rows[0];

  let observationsResult;
  try {
    observationsResult = await pool.query<IndicatorObservation>(
      `SELECT io.indicator_code, i.name AS indicator_name, io.year, io.value
       FROM indicator_observations io
       JOIN indicators i ON i.code = io.indicator_code
       WHERE io.country_code = $1 AND io.has_value = true
       ORDER BY io.indicator_code, io.year`,
      [code],
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
