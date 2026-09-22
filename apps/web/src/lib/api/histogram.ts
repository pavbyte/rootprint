import { client } from '$lib/api/client';
import { UNKNOWN_LEVEL } from '$lib/constants/level-colors';
import { readApiError } from '$lib/api/errors';
import type { HistogramBucket, HistogramInput, HistogramResult } from '$lib/types';
import {
	computeHistogramIntervalSeconds,
	formatInterval,
	OTHER_VALUES,
	padHistogramBuckets
} from '$lib/utils/histogram';

/**
 * Docs whose field is absent or blank never reach the terms aggregation and become `UNKNOWN`.
 * Terms beyond the aggregation's size cap remain visible as a non-filterable "Other values"
 * series, keeping the stacked height equal to the bucket's total document count.
 */
function withSyntheticBuckets(
	counts: Record<string, number>,
	docCount: number,
	omittedCount: number
): Record<string, number> {
	const out: Record<string, number> = {};
	let known = 0;
	for (const [name, count] of Object.entries(counts)) {
		if (name === '') continue;
		out[name] = count;
		known += count;
	}
	const unknown = docCount - known - omittedCount;
	if (unknown > 0) out[UNKNOWN_LEVEL] = (out[UNKNOWN_LEVEL] ?? 0) + unknown;
	if (omittedCount > 0) out[OTHER_VALUES] = omittedCount;
	return out;
}

export async function fetchHistogram(
	input: HistogramInput,
	signal?: AbortSignal
): Promise<HistogramResult> {
	const { startTs: startSec, endTs: endSec } = input;
	const intervalSec = computeHistogramIntervalSeconds(endSec - startSec);
	const interval = formatInterval(intervalSec);

	const res = await client.api.indexes[':indexId'].logs.histogram.$get(
		{
			param: { indexId: input.indexId },
			query: {
				q: input.query,
				startTs: String(startSec),
				endTs: String(endSec),
				interval,
				...(input.breakdownField ? { breakdownField: input.breakdownField } : {})
			}
		},
		{ init: { signal } }
	);
	if (!res.ok) throw await readApiError(res, 'Histogram fetch failed');
	const json = await res.json();

	// Quickwit's date_histogram returns `key` in ms; normalize to seconds.
	const bucketMap = new Map<number, Omit<HistogramBucket, 'timestamp'>>();
	let totalDocCount = 0;
	for (const b of json.buckets) {
		bucketMap.set(Math.floor(b.key / 1000), {
			levels: withSyntheticBuckets(b.levels, b.docCount, b.omittedCount),
			breakdown: input.breakdownField
				? withSyntheticBuckets(b.breakdown ?? {}, b.docCount, b.breakdownOmittedCount ?? 0)
				: {},
			count: b.docCount
		});
		totalDocCount += b.docCount;
	}

	const buckets: HistogramBucket[] = padHistogramBuckets(bucketMap, startSec, endSec, intervalSec);
	return { buckets, totalDocCount };
}
