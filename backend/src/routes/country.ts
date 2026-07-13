import { Router } from 'express';
import { pool } from '../db.js';
import { generateAnalysis } from '../vertex.js';
import { buildV1Prompt, type IndicatorObservation } from '../prompt.js';

export const countryRouterV1 = Router();

countryRouterV1.get('/api/v1/country/:code', async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();

    const countryResult = await pool.query<{ code: string; name: string }>(
      'SELECT code, name FROM countries WHERE code = $1',
      [code],
    );
    if (countryResult.rowCount === 0) {
      res.status(404).json({ error: `Country '${code}' not found` });
      return;
    }
    const country = countryResult.rows[0];

    const observationsResult = await pool.query<IndicatorObservation>(
      `SELECT io.indicator_code, i.name AS indicator_name, io.year, io.value
       FROM indicator_observations io
       JOIN indicators i ON i.code = io.indicator_code
       WHERE io.country_code = $1 AND io.has_value = true
       ORDER BY io.indicator_code, io.year`,
      [code],
    );

    const prompt = buildV1Prompt(country.name, observationsResult.rows);
    const analysis = await generateAnalysis(prompt);

    res.json({
      country_code: country.code,
      country_name: country.name,
      analysis,
    });
  } catch (err) {
    next(err);
  }
});
