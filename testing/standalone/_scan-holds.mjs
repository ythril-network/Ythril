/**
 * `ythril_scan_holds_total` as a scrape says it, for the tests that count a held scan (Q-697, b235).
 *
 * ## Why a module
 *
 * Two `-db` tests ask "how many holds were counted, and under which label": the contradiction scanner's hold and the `heldSince`
 * lifecycle. The scrape's text is parsed one way, and the wrong ways are quiet: a series that is not declared reads as zero when the
 * counter is summed by `?? 0`, so a "was not counted" row passes over a metric that does not exist. This returns `null` for "no series
 * declared", which a row can refuse, and the label VALUES as the scrape names them, so a row derives the scanners from what the
 * registry declares and never lists them.
 */
import { metricSeries } from './_metric-series.mjs';

/** `{ '<labels as scraped>': value }` for every `ythril_scan_holds_total` series (read by `metricSeries`), or `null` when none is declared. */
export async function scanHoldSeries(registry) {
  const declared = await metricSeries('ythril_scan_holds_total', { absent: 'null', registry });
  if (declared === null) return null;
  const series = {};
  for (const s of declared) series[Object.entries(s.labels).map(([k, v]) => `${k}="${v}"`).join(',')] = s.value;
  return series;
}

/** The sum of a `scanHoldSeries` answer (0 for none). */
export const scanHoldSum = (series) => Object.values(series ?? {}).reduce((a, b) => a + b, 0);

/** The values of the `scanner` label a scrape declares, from its series keys (`scanner="dupe"` gives `dupe`). */
export const scannerLabelsOf = (series) => Object.keys(series ?? {})
  .map(k => /(?:^|,)scanner="([^"]*)"/.exec(k)?.[1])
  .filter(v => v !== undefined);
