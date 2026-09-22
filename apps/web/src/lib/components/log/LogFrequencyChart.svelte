<script lang="ts">
	import type uPlotLib from 'uplot';

	import { ChevronDown, ChevronRight } from 'lucide-svelte';
	import { slide } from 'svelte/transition';

	import BreakdownPicker from '$lib/components/log/BreakdownPicker.svelte';
	import UplotChart from '$lib/components/ui/uplot/UplotChart.svelte';
	import { levelColor, UNKNOWN_LEVEL } from '$lib/constants/level-colors';
	import type { HistogramBucket, LogField } from '$lib/types';
	import { baseContentAt, cssVarColor } from '$lib/utils/chart-colors';
	import { formatCount } from '$lib/utils/format';
	import { formatInterval, OTHER_VALUES } from '$lib/utils/histogram';
	import { sortBySeverity } from '$lib/utils/severity';
	import { formatChartDate, formatChartTime, formatChartTooltip } from '$lib/utils/time';

	type Props = {
		buckets: HistogramBucket[];
		loading: boolean;
		error: string | null;
		collapsed: boolean;
		onBrush: (startTs: number, endTs: number) => void;
		fields: LogField[];
		breakdownField: string | null;
		levelField: string;
		onBreakdownChange: (field: string | null) => void;
		onBreakdownValue: (value: string) => void;
	};

	let {
		buckets,
		loading,
		error,
		collapsed = $bindable(false),
		onBrush,
		fields,
		breakdownField,
		levelField,
		onBreakdownChange,
		onBreakdownValue
	}: Props = $props();

	const SECONDS_PER_DAY = 86400;
	const HEIGHT = 150;
	/**
	 * The chart ramp minus `--chart-1`: that slot is `secondary` (near-black dark green), which
	 * reads as a hole in a stacked bar. Cycled for breakdowns on anything but severity.
	 */
	const BREAKDOWN_COLORS = ['var(--chart-2)', 'var(--chart-3)', 'var(--chart-5)', 'var(--chart-4)'];
	/**
	 * Whole-number tick steps (1/2/5 × powers of ten). uPlot's defaults go fractional on low-count
	 * ranges, which both misreads as "half an event" and collapses to duplicate compact labels.
	 */
	const COUNT_INCRS = Array.from({ length: 13 }, (_, exp) =>
		[1, 2, 5].map((mult) => mult * 10 ** exp)
	).flat();

	/**
	 * Level counts ride along on every histogram response, so the unbroken chart still stacks by
	 * severity — it just doesn't get the filterable legend that picking Severity does.
	 */
	const severityColored = $derived(breakdownField === null || breakdownField === levelField);
	const breakdownLabel = $derived.by(() => {
		if (breakdownField === null) return '';
		if (breakdownField === levelField) return 'Severity';
		return fields.find((field) => field.name === breakdownField)?.displayName ?? breakdownField;
	});

	const bucketWidthLabel = $derived.by<string | null>(() => {
		if (buckets.length < 2) return null;
		return formatInterval(buckets[1].timestamp - buckets[0].timestamp);
	});

	const bucketSeries = $derived.by<Record<string, number>[]>(() =>
		buckets.map((bucket) => {
			const counts = breakdownField === null ? bucket.levels : bucket.breakdown;
			const out: Record<string, number> = {};
			for (const [raw, count] of Object.entries(counts)) {
				// Severity is case-insensitive in practice: INFO and info are one series.
				const key = severityColored ? raw.toUpperCase() : raw;
				out[key] = (out[key] ?? 0) + count;
			}
			return out;
		})
	);

	const seriesKeys = $derived.by<string[]>(() => {
		const totals = new Map<string, number>();
		for (const values of bucketSeries) {
			for (const [key, count] of Object.entries(values)) {
				totals.set(key, (totals.get(key) ?? 0) + count);
			}
		}
		if (totals.size === 0 && buckets.length > 0) return [UNKNOWN_LEVEL];
		if (severityColored) return sortBySeverity([...totals.keys()]);
		return [...totals.keys()].toSorted(
			(left, right) =>
				(totals.get(right) ?? 0) - (totals.get(left) ?? 0) || left.localeCompare(right)
		);
	});

	const seriesColors = $derived.by<Record<string, string>>(() => {
		const map: Record<string, string> = {};
		for (const [index, key] of seriesKeys.entries()) {
			map[key] = severityColored
				? levelColor(key)
				: BREAKDOWN_COLORS[index % BREAKDOWN_COLORS.length];
		}
		return map;
	});

	function seriesLabel(key: string): string {
		return key === OTHER_VALUES ? 'Other values' : key;
	}

	const columnarData = $derived.by(() => {
		if (buckets.length === 0) return null;

		const timestamps: number[] = buckets.map((b) => b.timestamp);
		const rawSeries: number[][] = seriesKeys.map((key) =>
			bucketSeries.map((values) => values[key] ?? 0)
		);

		const stackedSeries: number[][] = [];
		for (let i = 0; i < rawSeries.length; i++) {
			const stacked = Array.from<number>({ length: timestamps.length });
			for (let j = 0; j < timestamps.length; j++) {
				stacked[j] = rawSeries[i][j] + (i > 0 ? stackedSeries[i - 1][j] : 0);
			}
			stackedSeries.push(stacked);
		}

		return {
			uplot: [timestamps, ...stackedSeries] as [number[], ...number[][]],
			rawSeries
		};
	});

	function makeOpts(UPlot: typeof uPlotLib): Omit<uPlotLib.Options, 'width' | 'height'> {
		const barPaths = UPlot.paths.bars?.({ size: [0.96, 64, 1], align: 0, gap: 1 }) ?? undefined;

		const series: uPlotLib.Series[] = [{ label: 'Time' }];
		const bands: uPlotLib.Band[] = [];

		for (let i = 0; i < seriesKeys.length; i++) {
			const token = seriesColors[seriesKeys[i]];
			// Canvas can't read a CSS custom property; severity colors are already literal.
			const color = token.startsWith('var(') ? cssVarColor(token) : token;
			series.push({
				label: seriesLabel(seriesKeys[i]),
				fill: color,
				stroke: color,
				width: 0,
				paths: barPaths,
				points: { show: false }
			});
			if (i > 0) {
				bands.push({ series: [i + 1, i] as [number, number], fill: color });
			}
		}

		const timestamps = columnarData?.uplot[0] ?? [];
		const span = timestamps.length > 1 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
		const useDate = span > SECONDS_PER_DAY;
		const halfBucket = (timestamps.length > 1 ? timestamps[1] - timestamps[0] : 1) / 2;

		const axisStroke = baseContentAt(0.65);
		const gridStroke = baseContentAt(0.1);

		return {
			series,
			bands,
			cursor: { drag: { x: true, y: false, setScale: false } },
			select: { show: true, left: 0, top: 0, width: 0, height: 0 },
			hooks: {
				setSelect: [
					(u: uPlotLib) => {
						const left = u.select.left;
						const selWidth = u.select.width;
						if (selWidth > 2) {
							const startTs = Math.floor(u.posToVal(left, 'x'));
							const endTs = Math.ceil(u.posToVal(left + selWidth, 'x'));
							onBrush(startTs, endTs);
						}
						u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
					}
				]
			},
			scales: {
				x: { time: true, range: (_u, min, max) => [min - halfBucket, max + halfBucket] },
				y: { range: (_u, _min, max) => [0, max || 1] }
			},
			axes: [
				{
					stroke: axisStroke,
					grid: { show: false },
					ticks: { show: false },
					gap: 2,
					size: 20,
					space: 120,
					values: (_u, splits) =>
						splits.map((v) => (useDate ? formatChartDate(v) : formatChartTime(v)))
				},
				{
					stroke: axisStroke,
					grid: { show: true, stroke: gridStroke, width: 0.8 },
					ticks: { show: false },
					incrs: COUNT_INCRS,
					// Compact labels ("450.0M") so high-volume indexes stay inside the gutter;
					// the grouped form ("450,139,944") overflowed it and rendered clipped.
					size: 50,
					values: (_u, splits) => splits.map((v) => formatCount(Number(v)))
				}
			]
		};
	}
</script>

<div class="border-line">
	<div class="flex items-center px-3 py-1.5">
		<button
			type="button"
			class="flex flex-1 items-center gap-1.5"
			aria-expanded={!collapsed}
			onclick={() => (collapsed = !collapsed)}
		>
			{#if collapsed}
				<ChevronRight class="text-base-content/40 h-2.5 w-2.5" />
			{:else}
				<ChevronDown class="text-base-content/40 h-2.5 w-2.5" />
			{/if}
			<span class="section-label text-left"> Frequency </span>
		</button>
		<div class="flex items-center gap-3">
			<BreakdownPicker {fields} {levelField} value={breakdownField} onChange={onBreakdownChange} />
			<div class="text-subtle flex items-center gap-1.5 text-xs tabular-nums">
				{#if loading}
					<span class="loading loading-spinner loading-xs mr-1"></span>
				{/if}
				{#if bucketWidthLabel}
					<span class="text-base-content/80">{bucketWidthLabel}</span>
					<span>buckets</span>
				{/if}
			</div>
		</div>
	</div>

	{#if !collapsed}
		<div transition:slide={{ duration: 200 }}>
			<div class="px-2 pb-2">
				{#if error}
					<div class="flex h-[150px] items-center justify-center">
						<p class="text-error/80 text-xs">{error}</p>
					</div>
				{:else if loading}
					<div class="flex h-[150px] items-center justify-center">
						<span class="loading loading-spinner loading-sm" aria-label="Loading frequency chart"
						></span>
					</div>
				{:else if !columnarData}
					<div class="flex h-[150px] flex-col items-center justify-center gap-1">
						<p class="text-muted text-xs">No frequency data</p>
						<p class="text-subtle text-xs">Try adjusting your time range or query filters</p>
					</div>
				{:else}
					<div class="flex items-start gap-2">
						<div class="min-w-0 flex-1">
							<UplotChart data={columnarData.uplot} height={HEIGHT} {makeOpts}>
								{#snippet tooltip(idx)}
									<div class="text-muted mb-1 text-xs tabular-nums">
										{formatChartTooltip(columnarData.uplot[0][idx])}
									</div>
									{#each seriesKeys as key, i (key)}
										{@const count = columnarData.rawSeries[i][idx]}
										{#if count > 0}
											<div class="flex items-center gap-1.5 text-xs">
												<span
													class="inline-block h-2 w-2 rounded-sm"
													style="background-color: {seriesColors[key]}"
												></span>
												<span class="text-base-content/80">{seriesLabel(key)}</span>
												<span class="text-base-content ml-auto font-mono"
													>{count.toLocaleString()}</span
												>
											</div>
										{/if}
									{/each}
								{/snippet}
							</UplotChart>
						</div>
						{#if breakdownField !== null}
							<ul
								class="w-40 shrink-0 space-y-1 overflow-y-auto pt-1 pr-1"
								style="max-height: {HEIGHT}px"
								aria-label="Breakdown values"
							>
								{#each seriesKeys as key (key)}
									{@const missing = key === UNKNOWN_LEVEL}
									{@const omitted = key === OTHER_VALUES}
									<li>
										<button
											type="button"
											class="hover:text-base-content flex w-full items-center gap-1.5 text-left text-xs"
											class:text-subtle={missing || omitted}
											disabled={missing || omitted}
											title={missing || omitted
												? `${seriesLabel(key)} cannot be filtered`
												: `Filter by ${breakdownLabel}: ${key}`}
											onclick={() => onBreakdownValue(key)}
										>
											<span
												class="inline-block h-2 w-2 shrink-0 rounded-sm"
												style="background-color: {seriesColors[key]}"
											></span>
											<span class="truncate">{seriesLabel(key)}</span>
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
