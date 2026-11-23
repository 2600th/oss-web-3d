// Builds the terrain's ground-data layer off the main thread (groundData.js).
import { buildGroundData } from './groundData.js';

self.onmessage = (e) => {
  const t0 = performance.now();
  const data = buildGroundData(e.data);
  self.postMessage({ data, ms: performance.now() - t0 }, [data.buffer]);
};
