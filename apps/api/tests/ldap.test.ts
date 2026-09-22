import { beforeEach, expect, test } from 'bun:test';

import { resetDb } from './helpers/db.js';
import { providers, seedAdmin } from './helpers/fixtures.js';
import { Jar, json } from './helpers/http.js';

const ldapConfig = {
	host: 'ldap.example.com',
	port: 636,
	useSsl: true,
	startTls: false,
	sslSkipVerify: false,
	bindDn: 'CN=rootprint,OU=service,DC=example,DC=com',
	bindPassword: 'directory-secret',
	searchFilter: '(sAMAccountName=%s)',
	searchBaseDns: ['OU=people,DC=example,DC=com'],
	groupSearchFilter: '',
	groupSearchBaseDns: [],
	groupSearchFilterUserAttribute: '',
	attributes: {
		name: 'givenName',
		surname: 'sn',
		username: 'sAMAccountName',
		memberOf: 'memberOf',
		email: 'mail'
	},
	groupMappings: [{ groupDn: '*', role: 'user' as const }]
};

beforeEach(resetDb);

test('LDAP settings are validated, redacted, advertised, and removable', async () => {
	const admin = await seedAdmin();

	const missingPassword = await admin.put('/api/settings/auth/ldap', {
		...ldapConfig,
		bindPassword: ''
	});
	expect(missingPassword.status).toBe(400);

	expect((await admin.put('/api/settings/auth/ldap', ldapConfig)).status).toBe(204);
	expect((await providers()).ldap.enabled).toBe(true);

	const status = await json<Record<string, unknown>>(await admin.get('/api/settings/auth/ldap'));
	expect(status.configured).toBe(true);
	expect(status.host).toBe(ldapConfig.host);
	expect(status).not.toHaveProperty('bindPassword');

	// An empty password on updates retains the stored secret.
	expect(
		(await admin.put('/api/settings/auth/ldap', { ...ldapConfig, bindPassword: '' })).status
	).toBe(204);

	expect((await admin.delete('/api/settings/auth/ldap')).status).toBe(204);
	expect((await providers()).ldap.enabled).toBe(false);
});

test('LDAP sign-in is unavailable until LDAP is configured', async () => {
	const jar = new Jar();
	const response = await jar.post('/api/auth/ldap/sign-in', {
		username: 'member',
		password: 'secret'
	});
	expect(response.status).toBe(404);
});
