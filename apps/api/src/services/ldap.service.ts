import { Client, type Entry } from 'ldapts';
import { APIError } from 'better-auth/api';

import type { LdapConfig, UserRole } from '../types.js';
import { badRequest } from '../utils/http-error.js';

export type LdapIdentity = {
	dn: string;
	email: string;
	name: string;
	username: string;
	role: UserRole;
};

const LDAP_TIMEOUT_MS = 5000;

const TLS_CERT_CODES = new Set([
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'CERT_HAS_EXPIRED',
	'ERR_TLS_CERT_ALTNAME_INVALID'
]);

/** Directory failures reach an admin, so report the cause rather than letting it mask as a 500. */
function describeLdapFailure(err: unknown): string | null {
	if (typeof err !== 'object' || err === null) return null;
	const { name, code } = err as { name?: string; code?: unknown };
	if (name === 'InvalidCredentialsError') return 'The directory rejected the bind DN or password.';
	if (name === 'InsufficientAccessError') return 'The bind account lacks permission to search.';
	if (typeof code !== 'string') return null;
	if (TLS_CERT_CODES.has(code)) {
		return 'The server certificate could not be verified. Enable "Skip certificate verification" if the directory uses an internal certificate authority.';
	}
	switch (code) {
		case 'ECONNRESET':
		case 'EPIPE':
			return 'The server accepted the TCP connection then closed it during the bind. Directories that require LDAPS or LDAP signing reject cleartext binds — enable "Use SSL" and use port 636, or 3269 for the Active Directory Global Catalog.';
		case 'ECONNREFUSED':
			return 'The server refused the connection. Check the host and port.';
		case 'ETIMEDOUT':
		case 'ERR_SOCKET_CONNECTION_TIMEOUT':
			return 'The connection timed out. Check the host, port, and any firewall between Rootprint and the directory.';
		case 'ENOTFOUND':
		case 'EAI_AGAIN':
			return 'The host could not be resolved.';
		default:
			return null;
	}
}

function escapeFilterValue(value: string): string {
	return value.replace(/[\0()*\\]/g, (char) => {
		const code = char.charCodeAt(0).toString(16).padStart(2, '0');
		return `\\${code}`;
	});
}

function attributeValues(entry: Entry, attribute: string): string[] {
	const value = entry[attribute];
	if (Array.isArray(value)) return value.map(String);
	if (value === undefined || value === null) return [];
	return [String(value)];
}

function firstAttribute(entry: Entry, attribute: string): string {
	return attributeValues(entry, attribute)[0] ?? '';
}

function createClient(config: LdapConfig): Client {
	const protocol = config.useSsl ? 'ldaps' : 'ldap';
	return new Client({
		url: `${protocol}://${config.host}:${config.port}`,
		timeout: LDAP_TIMEOUT_MS,
		connectTimeout: LDAP_TIMEOUT_MS,
		tlsOptions: { rejectUnauthorized: !config.sslSkipVerify }
	});
}

async function secureAndBind(client: Client, config: LdapConfig): Promise<void> {
	if (config.startTls) {
		await client.startTLS({ rejectUnauthorized: !config.sslSkipVerify });
	}
	await client.bind(config.bindDn, config.bindPassword);
}

async function findUser(client: Client, config: LdapConfig, username: string): Promise<Entry> {
	const filter = config.searchFilter.replaceAll('%s', escapeFilterValue(username));
	const attributes = Array.from(
		new Set(
			[
				config.attributes.name,
				config.attributes.surname,
				config.attributes.username,
				config.attributes.memberOf,
				config.attributes.email,
				config.groupSearchFilterUserAttribute
			].filter((attribute): attribute is string => !!attribute)
		)
	);
	const matches: Entry[] = [];
	for (const base of config.searchBaseDns) {
		// Searches stop after the first unambiguous match; they intentionally share one bound client.
		// eslint-disable-next-line no-await-in-loop
		const result = await client.search(base, {
			scope: 'sub',
			filter,
			attributes,
			sizeLimit: 2
		});
		matches.push(...result.searchEntries);
		if (matches.length > 1) break;
	}
	if (matches.length !== 1) {
		throw new APIError('UNAUTHORIZED', { message: 'Invalid username or password' });
	}
	return matches[0];
}

async function groupDnsFor(client: Client, config: LdapConfig, entry: Entry): Promise<string[]> {
	const memberOf = attributeValues(entry, config.attributes.memberOf);
	if (!config.groupSearchFilter || !config.groupSearchBaseDns?.length) return memberOf;
	const sourceAttribute = config.groupSearchFilterUserAttribute || config.attributes.username;
	const sourceValue = firstAttribute(entry, sourceAttribute);
	if (!sourceValue) return memberOf;
	const filter = config.groupSearchFilter.replaceAll('%s', escapeFilterValue(sourceValue));
	const groups = [...memberOf];
	for (const base of config.groupSearchBaseDns) {
		// Group bases intentionally share the authenticated search connection.
		// eslint-disable-next-line no-await-in-loop
		const result = await client.search(base, {
			scope: 'sub',
			filter,
			attributes: ['dn']
		});
		groups.push(...result.searchEntries.map((group) => group.dn));
	}
	return Array.from(new Set(groups));
}

function mappedRole(config: LdapConfig, groups: string[]): UserRole {
	const normalized = new Set(groups.map((dn) => dn.toLowerCase()));
	const exact = config.groupMappings.find(
		(mapping) => mapping.groupDn !== '*' && normalized.has(mapping.groupDn.toLowerCase())
	);
	const fallback = config.groupMappings.find((mapping) => mapping.groupDn === '*');
	const role = exact?.role ?? fallback?.role;
	if (!role) throw new APIError('FORBIDDEN', { message: 'LDAP user is not in an allowed group' });
	return role;
}

export async function testLdapConnection(config: LdapConfig): Promise<void> {
	const client = createClient(config);
	try {
		await secureAndBind(client, config);
	} catch (err) {
		const reason = describeLdapFailure(err);
		if (reason) throw badRequest(reason, 'LDAP_CONNECTION_FAILED');
		throw err;
	} finally {
		await client.unbind().catch(() => undefined);
	}
}

export async function authenticateLdap(
	config: LdapConfig,
	username: string,
	password: string
): Promise<LdapIdentity> {
	const searchClient = createClient(config);
	try {
		await secureAndBind(searchClient, config);
		const entry = await findUser(searchClient, config, username);
		const groups = await groupDnsFor(searchClient, config, entry);

		const userClient = createClient(config);
		try {
			if (config.startTls) {
				await userClient.startTLS({ rejectUnauthorized: !config.sslSkipVerify });
			}
			await userClient.bind(entry.dn, password);
		} catch {
			throw new APIError('UNAUTHORIZED', { message: 'Invalid username or password' });
		} finally {
			await userClient.unbind().catch(() => undefined);
		}

		const email = firstAttribute(entry, config.attributes.email).trim().toLowerCase();
		if (!email) throw new APIError('FORBIDDEN', { message: 'LDAP account has no email attribute' });
		const givenName = firstAttribute(entry, config.attributes.name).trim();
		const surname = firstAttribute(entry, config.attributes.surname).trim();
		const ldapUsername = firstAttribute(entry, config.attributes.username).trim() || username;
		return {
			dn: entry.dn,
			email,
			name: [givenName, surname].filter(Boolean).join(' ') || ldapUsername,
			username: ldapUsername,
			role: mappedRole(config, groups)
		};
	} finally {
		await searchClient.unbind().catch(() => undefined);
	}
}
