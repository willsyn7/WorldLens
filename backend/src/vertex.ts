import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

const ai = new GoogleGenAI({
  enterprise: true,
  project: config.vertex.projectId,
  location: config.vertex.region,
});

export async function generateAnalysis(prompt: string): Promise<string> {
  const response = await ai.models.generateContent({
    model: config.vertex.modelId,
    contents: prompt,
  });
  return response.text ?? '';
}
