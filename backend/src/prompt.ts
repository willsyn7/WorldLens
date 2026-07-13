export interface IndicatorObservation {
  indicator_code: string;
  indicator_name: string;
  year: number;
  value: number | null;
}

const SYSTEM_FRAMING = (countryName: string): string =>
  `You are an AI agent recommending whether a company should invest in ` +
  `${countryName}. Base your analysis primarily on the World Bank economic ` +
  `and governance data provided below. You may use general background ` +
  `knowledge of the country to explain notable trends in the data (e.g. a ` +
  `political event that coincides with a sharp change in the numbers), but ` +
  `do not state unverifiable claims as if they were part of the provided ` +
  `data. Return a short, decision-oriented analysis and a clear ` +
  `invest / do-not-invest recommendation.`;

export function buildV1Prompt(countryName: string, observations: IndicatorObservation[]): string {
  const data = observations.map((o) => ({
    indicator_code: o.indicator_code,
    indicator_name: o.indicator_name,
    year: o.year,
    value: o.value,
  }));

  return `${SYSTEM_FRAMING(countryName)}\n\nData:\n${JSON.stringify(data)}`;
}
