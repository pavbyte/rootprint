import type { PageLoad } from './$types';
import { getLdapAuth } from '$lib/api/auth-config';

export const load: PageLoad = async () => ({ ldap: await getLdapAuth() });
