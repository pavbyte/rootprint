import type { PageLoad } from './$types';
import { getGoogleAuth, getGitHubAuth, getLdapAuth, getOidcAuth } from '$lib/api/auth-config';

export const load: PageLoad = async () => {
	const [google, github, oidc, ldap] = await Promise.all([
		getGoogleAuth(),
		getGitHubAuth(),
		getOidcAuth(),
		getLdapAuth()
	]);
	return { google, github, oidc, ldap };
};
