<script lang="ts">
	import * as v from 'valibot';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { ldapConfigSchema, type LdapConfigInput } from 'api/schemas';
	import { removeLdapConfig, saveLdapConfig, testLdapConfig } from '$lib/api/auth-config';
	import { issuesToPathErrors, toFormErrors } from '$lib/api/errors';
	import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import SettingsRow from '$lib/components/ui/SettingsRow.svelte';
	import TagInput from '$lib/components/ui/TagInput.svelte';

	type LdapFormConfig = Omit<
		LdapConfigInput,
		'groupSearchFilter' | 'groupSearchBaseDns' | 'groupSearchFilterUserAttribute'
	> & {
		groupSearchFilter: string;
		groupSearchBaseDns: string[];
		groupSearchFilterUserAttribute: string;
	};

	let { data } = $props();
	const initial = untrack(() => data.ldap);
	let config = $state<LdapFormConfig>({
		host: initial.host,
		port: initial.port,
		useSsl: initial.useSsl,
		startTls: initial.startTls,
		sslSkipVerify: initial.sslSkipVerify,
		bindDn: initial.bindDn,
		bindPassword: '',
		searchFilter: initial.searchFilter,
		searchBaseDns: [...initial.searchBaseDns],
		groupSearchFilter: initial.groupSearchFilter,
		groupSearchBaseDns: [...initial.groupSearchBaseDns],
		groupSearchFilterUserAttribute: initial.groupSearchFilterUserAttribute,
		attributes: { ...initial.attributes },
		groupMappings: initial.groupMappings.map((mapping) => Object.assign({}, mapping))
	});
	let formError = $state<string | null>(null);
	let fieldErrors = $state<Record<string, string>>({});
	let submitting = $state(false);
	let testing = $state(false);
	let removeOpen = $state(false);
	let searchBaseDnDraft = $state('');
	let groupSearchBaseDnDraft = $state('');

	/** Tag drafts are only committed on Enter, so fold them in before validating. */
	function commitTagDrafts() {
		const searchBaseDn = searchBaseDnDraft.trim();
		if (searchBaseDn && !config.searchBaseDns.includes(searchBaseDn)) {
			config.searchBaseDns = [...config.searchBaseDns, searchBaseDn];
		}
		searchBaseDnDraft = '';

		const groupBaseDn = groupSearchBaseDnDraft.trim();
		if (groupBaseDn && !config.groupSearchBaseDns.includes(groupBaseDn)) {
			config.groupSearchBaseDns = [...config.groupSearchBaseDns, groupBaseDn];
		}
		groupSearchBaseDnDraft = '';
	}

	function validate(): LdapConfigInput | null {
		commitTagDrafts();
		const parsed = v.safeParse(ldapConfigSchema, config);
		if (parsed.success) return parsed.output;
		fieldErrors = issuesToPathErrors(parsed.issues);
		formError = fieldErrors['(root)'] ?? 'Fix the highlighted fields and try again.';
		return null;
	}

	function addMapping() {
		config.groupMappings = [...config.groupMappings, { groupDn: '', role: 'user' }];
	}

	function removeMapping(index: number) {
		config.groupMappings = config.groupMappings.filter((_, current) => current !== index);
	}

	async function testConnection() {
		formError = null;
		fieldErrors = {};
		const input = validate();
		if (!input) return;
		testing = true;
		try {
			await testLdapConfig(input);
			toast.success('LDAP connection succeeded');
		} catch (err) {
			const errors = toFormErrors(err, 'LDAP connection failed');
			formError = errors.message;
			fieldErrors = errors.fieldErrors;
		} finally {
			testing = false;
		}
	}

	async function onsubmit(e: SubmitEvent) {
		e.preventDefault();
		formError = null;
		fieldErrors = {};
		const input = validate();
		if (!input) return;
		submitting = true;
		try {
			await saveLdapConfig(input);
			toast.success('LDAP authentication settings saved');
			await goto('/settings/authentication', { invalidateAll: true });
		} catch (err) {
			const errors = toFormErrors(err, 'Failed to save LDAP settings');
			formError = errors.message;
			fieldErrors = errors.fieldErrors;
		} finally {
			submitting = false;
		}
	}

	async function onRemove() {
		await removeLdapConfig();
		toast.success('LDAP authentication removed');
		await goto('/settings/authentication', { invalidateAll: true });
	}
</script>

<div class="settings-page">
	<PageHeader
		title="LDAP"
		description="Connect Rootprint to an LDAP or Active Directory server. Configuration is stored by Rootprint; no toml file is required."
	/>

	{#if formError}
		<div role="alert" class="alert alert-error mt-6 text-sm">{formError}</div>
	{/if}

	<form
		{onsubmit}
		class="border-line rounded-box bg-base-100 divide-line mt-8 flex flex-col divide-y border"
	>
		<div class="px-4 py-3">
			<p class="section-label">Server</p>
		</div>
		<SettingsRow label="Host" hint="LDAP hostname or IP address." error={fieldErrors.host}>
			<input
				class="input input-sm w-full"
				bind:value={config.host}
				placeholder="ldap.example.com"
			/>
		</SettingsRow>
		<SettingsRow
			label="Port"
			hint="Usually 389, 636 for LDAPS, or 3268 for AD Global Catalog."
			error={fieldErrors.port}
		>
			<input
				class="input input-sm w-full"
				type="number"
				min="1"
				max="65535"
				bind:value={config.port}
			/>
		</SettingsRow>
		<SettingsRow plain label="Transport">
			<div class="flex flex-wrap gap-5 text-sm">
				<label class="label cursor-pointer gap-2">
					<input class="checkbox checkbox-sm" type="checkbox" bind:checked={config.useSsl} />
					Use SSL
				</label>
				<label class="label cursor-pointer gap-2">
					<input class="checkbox checkbox-sm" type="checkbox" bind:checked={config.startTls} />
					StartTLS
				</label>
				<label class="label cursor-pointer gap-2">
					<input class="checkbox checkbox-sm" type="checkbox" bind:checked={config.sslSkipVerify} />
					Skip certificate verification
				</label>
			</div>
			{#if !config.useSsl && !config.startTls}
				<p class="text-warning-ink mt-2 text-xs">
					Bind credentials will travel over an unencrypted connection.
				</p>
			{/if}
		</SettingsRow>

		<div class="px-4 py-3"><p class="section-label">Search bind</p></div>
		<SettingsRow
			label="Bind DN"
			hint="Service account used to search for users."
			error={fieldErrors.bindDn}
		>
			<input class="input input-sm w-full" bind:value={config.bindDn} />
		</SettingsRow>
		<SettingsRow
			label="Bind password"
			hint={initial.configured ? 'Leave blank to keep the stored password.' : 'Required.'}
			error={fieldErrors.bindPassword}
		>
			<input
				class="input input-sm w-full"
				type="password"
				bind:value={config.bindPassword}
				autocomplete="new-password"
			/>
		</SettingsRow>

		<div class="px-4 py-3"><p class="section-label">User search</p></div>
		<SettingsRow
			label="Search filter"
			hint="%s is replaced with the escaped username."
			error={fieldErrors.searchFilter}
		>
			<input class="input input-sm w-full font-mono" bind:value={config.searchFilter} />
		</SettingsRow>
		<SettingsRow
			plain
			label="Search base DNs"
			hint="Directories searched for user entries."
			error={fieldErrors.searchBaseDns}
		>
			<TagInput
				bind:tags={config.searchBaseDns}
				bind:input={searchBaseDnDraft}
				error={!!fieldErrors.searchBaseDns}
				placeholderEmpty="DC=example,DC=com"
				addLabel="Add base DN"
			/>
		</SettingsRow>

		<div class="px-4 py-3"><p class="section-label">Attributes</p></div>
		{#each Object.keys(config.attributes) as key}
			<SettingsRow
				label={key === 'memberOf' ? 'Member of' : key[0].toUpperCase() + key.slice(1)}
				error={fieldErrors[`attributes.${key}`]}
			>
				<input
					class="input input-sm w-full font-mono"
					bind:value={config.attributes[key as keyof typeof config.attributes]}
				/>
			</SettingsRow>
		{/each}

		<div class="px-4 py-3"><p class="section-label">Groups and roles</p></div>
		<SettingsRow
			label="Group search filter"
			hint="Optional for directories without memberOf. Use %s for the user attribute."
			error={fieldErrors.groupSearchFilter}
		>
			<input class="input input-sm w-full font-mono" bind:value={config.groupSearchFilter} />
		</SettingsRow>
		<SettingsRow
			plain
			label="Group search base DNs"
			hint="Optional directories searched for groups."
			error={fieldErrors.groupSearchBaseDns}
		>
			<TagInput
				bind:tags={config.groupSearchBaseDns}
				bind:input={groupSearchBaseDnDraft}
				error={!!fieldErrors.groupSearchBaseDns}
				placeholderEmpty="OU=groups,DC=example,DC=com"
				addLabel="Add group base DN"
			/>
		</SettingsRow>
		<SettingsRow
			label="Group search user attribute"
			hint="For example uid. Leave blank to use the username attribute."
			error={fieldErrors.groupSearchFilterUserAttribute}
		>
			<input
				class="input input-sm w-full font-mono"
				bind:value={config.groupSearchFilterUserAttribute}
			/>
		</SettingsRow>
		<SettingsRow
			plain
			label="Group mappings"
			hint="First exact DN wins; * supplies the fallback role."
			error={fieldErrors.groupMappings}
		>
			<div class="space-y-2">
				{#each config.groupMappings as mapping, index}
					<div class="flex gap-2">
						<input
							class="input input-sm min-w-0 flex-1 font-mono"
							bind:value={mapping.groupDn}
							placeholder="CN=group,OU=groups,DC=example,DC=com"
						/>
						<select class="select select-sm w-28" bind:value={mapping.role}>
							<option value="user">User</option>
							<option value="admin">Admin</option>
						</select>
						<button type="button" class="btn btn-ghost btn-sm" onclick={() => removeMapping(index)}
							>Remove</button
						>
					</div>
					{#if fieldErrors[`groupMappings.${index}.groupDn`]}
						<p class="text-error text-xs">{fieldErrors[`groupMappings.${index}.groupDn`]}</p>
					{/if}
				{/each}
				<button type="button" class="btn btn-ghost btn-sm" onclick={addMapping}>Add mapping</button>
			</div>
		</SettingsRow>

		<div class="flex items-center justify-between px-4 py-3">
			{#if initial.configured}
				<button
					type="button"
					class="btn btn-error btn-outline btn-sm"
					onclick={() => (removeOpen = true)}>Remove LDAP</button
				>
			{:else}
				<span></span>
			{/if}
			<div class="flex gap-2">
				<button
					type="button"
					class="btn btn-outline btn-sm"
					disabled={testing || submitting}
					onclick={testConnection}
				>
					{testing ? 'Testing…' : 'Test connection'}
				</button>
				<button type="submit" class="btn btn-primary btn-sm" disabled={testing || submitting}>
					{submitting ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>
	</form>
</div>

<ConfirmModal
	bind:open={removeOpen}
	title="Remove LDAP authentication"
	confirmLabel="Remove"
	confirmingLabel="Removing…"
	errorFallback="Failed to remove LDAP authentication"
	onConfirm={onRemove}
>
	{#snippet message()}
		Remove the saved LDAP configuration? LDAP users will no longer be able to sign in.
	{/snippet}
</ConfirmModal>
