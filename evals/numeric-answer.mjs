export function numericAnswerMatches(value, reference) {
  if (!Number.isFinite(value) || !Number.isFinite(reference)) return false;
  const tolerance = reference === 0 ? 1e-8 : Math.abs(reference) * 0.01;
  return Math.abs(value - reference) <= tolerance;
}
