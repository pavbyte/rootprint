import * as v from 'valibot';

import { named } from '../../lib/openapi/describe.js';

// Redacted Google auth status: whether credentials are configured (no secret).
export const GoogleAuthSettingsResponse = named(
	'GoogleAuthSettingsResponse',
	v.object({
		configured: v.boolean(),
		allowedDomains: v.array(v.string())
	})
);

// Redacted GitHub auth status: whether credentials are configured (no secret).
export const GitHubAuthSettingsResponse = named(
	'GitHubAuthSettingsResponse',
	v.object({
		configured: v.boolean(),
		allowedOrgs: v.array(v.string())
	})
);

export const OidcAuthSettingsResponse = named(
	'OidcAuthSettingsResponse',
	v.object({
		configured: v.boolean(),
		issuerUrl: v.nullable(v.string())
	})
);

export const LdapAuthSettingsResponse = named(
	'LdapAuthSettingsResponse',
	v.object({
		configured: v.boolean(),
		host: v.string(),
		port: v.number(),
		useSsl: v.boolean(),
		startTls: v.boolean(),
		sslSkipVerify: v.boolean(),
		bindDn: v.string(),
		searchFilter: v.string(),
		searchBaseDns: v.array(v.string()),
		groupSearchFilter: v.string(),
		groupSearchBaseDns: v.array(v.string()),
		groupSearchFilterUserAttribute: v.string(),
		attributes: v.object({
			name: v.string(),
			surname: v.string(),
			username: v.string(),
			memberOf: v.string(),
			email: v.string()
		}),
		groupMappings: v.array(v.object({ groupDn: v.string(), role: v.picklist(['admin', 'user']) }))
	})
);
