<script lang="ts">
	import { tick } from 'svelte';
	import { Check, ChevronDown, Search } from 'lucide-svelte';

	import type { LogField } from '$lib/types';

	let {
		fields,
		levelField,
		value,
		onChange
	}: {
		fields: LogField[];
		/** Offered as "Severity"; field discovery hides it, so it has no entry in `fields`. */
		levelField: string;
		value: string | null;
		onChange: (field: string | null) => void;
	} = $props();

	const NONE = '';

	const dd = $props.id();
	const listboxId = `${dd}-listbox`;
	let panelEl = $state<HTMLDivElement | null>(null);
	let searchEl = $state<HTMLInputElement | null>(null);
	let query = $state('');
	let open = $state(false);
	let activeIndex = $state(0);

	const options = $derived.by(() => {
		const sorted = fields
			.filter((field) => field.name !== levelField)
			.map((field) => ({ value: field.name, label: field.displayName }))
			.toSorted((left, right) => left.label.localeCompare(right.label));
		if (levelField !== '') sorted.unshift({ value: levelField, label: 'Severity' });
		// A breakdown restored from a URL or saved view can name a field discovery hasn't listed.
		if (value !== null && !sorted.some((option) => option.value === value)) {
			sorted.push({ value, label: value });
		}
		return [{ value: NONE, label: 'No breakdown' }, ...sorted];
	});
	const filtered = $derived.by(() => {
		const normalized = query.trim().toLowerCase();
		return normalized === ''
			? options
			: options.filter((option) => option.label.toLowerCase().includes(normalized));
	});
	const selected = $derived(value ?? NONE);
	const label = $derived.by(() => {
		if (value === null) return 'No breakdown';
		const match = options.find((option) => option.value === value);
		return `Breakdown by ${match?.label ?? value}`;
	});

	function close() {
		panelEl?.togglePopover(false);
	}

	function choose(next: string) {
		close();
		onChange(next === NONE ? null : next);
	}

	function moveActive(direction: number) {
		if (filtered.length === 0) return;
		activeIndex = (activeIndex + direction + filtered.length) % filtered.length;
		void tick().then(() => {
			document.getElementById(`${dd}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
		});
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveActive(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveActive(-1);
		} else if (event.key === 'Enter' && filtered[activeIndex]) {
			event.preventDefault();
			choose(filtered[activeIndex].value);
		}
	}

	function onToggle(event: Event) {
		open = (event as ToggleEvent).newState === 'open';
		if (!open) return;
		query = '';
		activeIndex = Math.max(
			0,
			options.findIndex((option) => option.value === selected)
		);
		void tick().then(() => searchEl?.focus());
	}
</script>

<button
	type="button"
	popovertarget={dd}
	style="anchor-name:--{dd}"
	class="border-base-content/20 bg-base-100 hover:bg-base-200 flex h-6 max-w-56 cursor-pointer items-center gap-1.5 rounded border px-2 text-xs"
	title={label}
	aria-label="Break down histogram by field"
	aria-haspopup="listbox"
	aria-expanded={open}
>
	<span class="truncate">{label}</span>
	<ChevronDown class="size-3 shrink-0 opacity-60" aria-hidden="true" />
</button>

<div
	bind:this={panelEl}
	popover
	id={dd}
	style="position-anchor:--{dd}"
	ontoggle={onToggle}
	class="dropdown border-line rounded-box bg-base-100 mt-1 w-64 border shadow-lg"
>
	<div class="border-line border-b p-2">
		<label class="input input-sm w-full">
			<Search class="size-3.5 opacity-60" aria-hidden="true" />
			<input
				bind:this={searchEl}
				bind:value={query}
				type="search"
				role="combobox"
				placeholder="Search fields…"
				aria-label="Search fields"
				aria-expanded="true"
				aria-controls={listboxId}
				aria-activedescendant={filtered[activeIndex] ? `${dd}-option-${activeIndex}` : undefined}
				oninput={() => (activeIndex = 0)}
				onkeydown={onKeydown}
			/>
		</label>
	</div>
	<div
		id={listboxId}
		role="listbox"
		aria-label="Breakdown field"
		class="max-h-64 overflow-y-auto py-1"
	>
		{#if filtered.length === 0}
			<p class="text-subtle px-3 py-6 text-center text-xs">No matching fields.</p>
		{:else}
			{#each filtered as option, index (option.value)}
				<button
					id={`${dd}-option-${index}`}
					type="button"
					role="option"
					aria-selected={option.value === selected}
					class="hover:bg-base-200 flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs"
					class:bg-base-200={index === activeIndex}
					onmousemove={() => (activeIndex = index)}
					onclick={() => choose(option.value)}
				>
					<span class="truncate" class:text-muted={option.value === NONE}>{option.label}</span>
					{#if option.value === selected}
						<Check class="size-3.5 shrink-0" aria-hidden="true" />
					{/if}
				</button>
			{/each}
		{/if}
	</div>
</div>
