/** Respect the provider's wait units instead of treating minute estimates as an unknown delay. */
/** @param {string} message */
export function quotaRetryDelay(message) {
  const match = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(message);
  if (!match) return 5 * 3600000;
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1;
  return (Number(match[1]) * multiplier + 30) * 1000;
}
