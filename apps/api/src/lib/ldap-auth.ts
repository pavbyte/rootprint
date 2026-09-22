import { randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, eq, sql } from 'drizzle-orm';

import { account, user } from '../db/auth.schema.js';
import { inviteToken } from '../db/schema.js';
import { db } from './db.js';
import { ldapSignInSchema } from '../schemas/settings.js';
import { authenticateLdap } from '../services/ldap.service.js';
import { loadLdapConfig } from '../services/settings.service.js';
import { isUniqueViolation } from '../utils/http-error.js';

function sameLdapDn(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function userEmailEquals(email: string) {
	return sql`lower(${user.email}) = ${email}`;
}

export function ldapAuth(): BetterAuthPlugin {
	return {
		id: 'rootprint-ldap',
		endpoints: {
			ldapSignIn: createAuthEndpoint(
				'/ldap/sign-in',
				{
					method: 'POST',
					body: ldapSignInSchema,
					requireHeaders: true
				},
				async (ctx) => {
					const config = await loadLdapConfig(db);
					if (!config) throw new APIError('NOT_FOUND', { message: 'LDAP is not configured' });
					const identity = await authenticateLdap(config, ctx.body.username, ctx.body.password);

					try {
						await db.transaction(async (tx) => {
							const [existingUser] = await tx
								.select({ id: user.id, isServiceAccount: user.isServiceAccount })
								.from(user)
								.where(userEmailEquals(identity.email))
								.limit(1);
							const [existingByDn] = await tx
								.select({ id: account.id, userId: account.userId, accountId: account.accountId })
								.from(account)
								.where(
									and(
										eq(account.providerId, 'ldap'),
										sql`lower(${account.accountId}) = ${identity.dn.toLowerCase()}`
									)
								)
								.limit(1);

							if (existingByDn && existingUser && existingByDn.userId !== existingUser.id) {
								throw new APIError('FORBIDDEN', {
									message: 'LDAP identity does not match the existing account for this email'
								});
							}
							if (existingByDn && !existingUser) {
								throw new APIError('FORBIDDEN', {
									message: 'LDAP identity is already linked to another account'
								});
							}
							if (existingUser?.isServiceAccount) {
								throw new APIError('FORBIDDEN', {
									message: 'LDAP identity cannot be linked to a service account'
								});
							}

							if (existingUser) {
								const [ldapAccount] = existingByDn
									? [existingByDn]
									: await tx
											.select({
												id: account.id,
												userId: account.userId,
												accountId: account.accountId
											})
											.from(account)
											.where(
												and(eq(account.userId, existingUser.id), eq(account.providerId, 'ldap'))
											)
											.limit(1);
								if (ldapAccount && !sameLdapDn(ldapAccount.accountId, identity.dn)) {
									throw new APIError('FORBIDDEN', {
										message: 'LDAP identity does not match the existing account for this email'
									});
								}

								await tx
									.update(user)
									.set({
										email: identity.email,
										name: identity.name,
										emailVerified: true,
										role: identity.role,
										updatedAt: new Date()
									})
									.where(eq(user.id, existingUser.id));

								if (ldapAccount) {
									if (ldapAccount.accountId !== identity.dn) {
										await tx
											.update(account)
											.set({ accountId: identity.dn, updatedAt: new Date() })
											.where(eq(account.id, ldapAccount.id));
									}
								} else {
									await tx.insert(account).values({
										id: randomUUID(),
										accountId: identity.dn,
										providerId: 'ldap',
										userId: existingUser.id
									});
								}
								await tx.delete(inviteToken).where(eq(inviteToken.userId, existingUser.id));
								return;
							}

							const userId = randomUUID();
							await tx.insert(user).values({
								id: userId,
								email: identity.email,
								name: identity.name,
								emailVerified: true,
								role: identity.role
							});
							await tx.insert(account).values({
								id: randomUUID(),
								accountId: identity.dn,
								providerId: 'ldap',
								userId
							});
						});
					} catch (err) {
						if (isUniqueViolation(err)) {
							throw new APIError('CONFLICT', { message: 'Email already in use' });
						}
						throw err;
					}

					const [ldapUser] = await db
						.select()
						.from(user)
						.where(userEmailEquals(identity.email))
						.limit(1);
					if (!ldapUser || ldapUser.isServiceAccount) {
						throw new APIError('FORBIDDEN', { message: 'User access is disabled' });
					}
					const newSession = await ctx.context.internalAdapter.createSession(ldapUser.id);
					await setSessionCookie(ctx, { session: newSession, user: ldapUser });
					return ctx.json({
						user: {
							id: ldapUser.id,
							email: ldapUser.email,
							name: ldapUser.name,
							role: ldapUser.role
						}
					});
				}
			)
		}
	};
}
