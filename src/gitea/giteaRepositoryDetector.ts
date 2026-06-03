/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Buffer } from 'buffer';
import fetch from 'cross-fetch';
import { getGiteaInstances, GiteaInstance } from './config';
import { Repository } from '../api/api';
import { parseRepositoryRemotes, Remote } from '../common/remote';

export interface GiteaRepositoryMatch {
	repository: Repository;
	remote: Remote;
	instance: GiteaInstance;
	owner: string;
	repo: string;
}

export async function findGiteaRepository(repository: Repository): Promise<GiteaRepositoryMatch | undefined> {
	const instances = await getGiteaInstances();
	for (const remote of parseRepositoryRemotes(repository)) {
		const matchingInstance = instances.find(instance => instance.host === remote.host.toLocaleLowerCase());
		if (matchingInstance && remote.owner && remote.repositoryName) {
			return {
				repository,
				remote,
				instance: matchingInstance,
				owner: remote.owner,
				repo: remote.repositoryName,
			};
		}
	}

	for (const remote of parseRepositoryRemotes(repository)) {
		if (!remote.owner || !remote.repositoryName || isGitHubHost(remote.host)) {
			continue;
		}
		const configuredInstance = instances.find(instance => instance.host === remote.host.toLocaleLowerCase());
		const candidateInstance: GiteaInstance = configuredInstance ?? {
			url: `https://${remote.host}`,
			baseUrl: `https://${remote.host}`,
			host: remote.host.toLocaleLowerCase(),
		};
		if (await isGiteaInstance(candidateInstance)) {
			return {
				repository,
				remote,
				instance: candidateInstance,
				owner: remote.owner,
				repo: remote.repositoryName,
			};
		}
	}
	return undefined;
}

function isGitHubHost(host: string): boolean {
	const normalized = host.toLocaleLowerCase();
	return normalized === 'github.com' || normalized.endsWith('.github.com');
}

async function isGiteaInstance(instance: GiteaInstance): Promise<boolean> {
	try {
		const response = await fetch(`${instance.baseUrl}/api/v1/version`, {
			headers: {
				'Accept': 'application/json',
				...authHeaders(instance.auth),
			},
		});
		if (response.ok) {
			return true;
		}
		// Some modern Gitea instances restrict all API endpoints to signed-in users.
		// A 401/403 from /api/v1/version on a non-GitHub remote is still enough to
		// surface the remote and let the normal PR calls use a configured token.
		return response.status === 401 || response.status === 403;
	} catch {
		return false;
	}
}

function authHeaders(auth: GiteaInstance['auth']): Record<string, string> {
	if (!auth) {
		return {};
	}
	if (auth.type === 'token') {
		return { 'Authorization': `token ${auth.token}` };
	}
	return { 'Authorization': `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
}
