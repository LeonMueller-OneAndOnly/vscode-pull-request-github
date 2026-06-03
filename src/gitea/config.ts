/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const GITEA_SETTINGS_NAMESPACE = 'giteaPullRequests';

export interface GiteaInstanceSetting {
	url: string;
	token?: string;
}

export interface GiteaInstance extends GiteaInstanceSetting {
	baseUrl: string;
	host: string;
	auth?: GiteaAuth;
}

export type GiteaAuth = { type: 'token'; token: string } | { type: 'basic'; username: string; password: string };

let secretStorage: vscode.SecretStorage | undefined;

export function initializeGiteaConfigSecrets(secrets: vscode.SecretStorage): void {
	secretStorage = secrets;
}

export async function getGiteaInstances(): Promise<GiteaInstance[]> {
	const instances = vscode.workspace.getConfiguration(GITEA_SETTINGS_NAMESPACE).get<GiteaInstanceSetting[]>('instances', []);
	const result: GiteaInstance[] = [];
	for (const instance of instances) {
		const url = vscode.Uri.parse(instance.url.replace(/\/$/, ''));
		const baseUrl = `${url.scheme}://${url.authority}`;
		const host = url.authority.split('@').pop()!.split(':')[0].toLocaleLowerCase();
		const auth = instance.token ? { type: 'token' as const, token: instance.token } : await getStoredAuth(baseUrl);
		if (baseUrl && host) {
			result.push({
			...instance,
			baseUrl,
			host,
			auth,
		});
		}
	}
	return result;
}

export async function storeGiteaBasicAuth(baseUrl: string, username: string, password: string): Promise<void> {
	if (!secretStorage) {
		throw new Error('Gitea SecretStorage has not been initialized.');
	}
	await secretStorage.store(secretKey(normalizeBaseUrl(baseUrl)), JSON.stringify({ type: 'basic', username, password } satisfies GiteaAuth));
}

export async function deleteGiteaAuth(baseUrl: string): Promise<void> {
	await secretStorage?.delete(secretKey(normalizeBaseUrl(baseUrl)));
}

export function normalizeBaseUrl(url: string): string {
	const parsed = vscode.Uri.parse(url.replace(/\/$/, ''));
	return `${parsed.scheme || 'https'}://${parsed.authority || parsed.path}`.replace(/\/$/, '');
}

async function getStoredAuth(baseUrl: string): Promise<GiteaAuth | undefined> {
	const raw = await secretStorage?.get(secretKey(baseUrl));
	if (!raw) {
		return undefined;
	}
	try {
		return JSON.parse(raw) as GiteaAuth;
	} catch {
		return undefined;
	}
}

function secretKey(baseUrl: string): string {
	return `gitea.auth.${baseUrl}`;
}
