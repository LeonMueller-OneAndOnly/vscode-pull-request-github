/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Buffer } from 'buffer';
import fetch from 'cross-fetch';
import { GiteaAuth } from './config';

export type GiteaPullRequestState = 'open' | 'closed' | 'all';
export type GiteaFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'binary' | 'unknown';

export interface GiteaUser {
	id: number;
	login: string;
	full_name?: string;
	avatar_url?: string;
}

export interface GiteaRepository {
	id: number;
	name: string;
	full_name: string;
	html_url: string;
	default_branch?: string;
	owner?: GiteaUser;
}

export interface GiteaPullRequest {
	id: number;
	number: number;
	title: string;
	state: 'open' | 'closed';
	html_url: string;
	created_at: string;
	updated_at: string;
	user: GiteaUser;
	head: { ref: string; sha: string; repo?: GiteaRepository };
	base: { ref: string; sha: string; repo?: GiteaRepository };
}

export interface GiteaChangedFile {
	filename: string;
	previousFilename?: string;
	status: GiteaFileStatus;
	additions?: number;
	deletions?: number;
	changes?: number;
	binary?: boolean;
}

export interface CreateGiteaPullRequestOptions {
	title: string;
	body?: string;
	head: string;
	base: string;
}

export class GiteaClient {
	constructor(private readonly baseUrl: string, private readonly auth?: GiteaAuth) { }

	async getVersion(): Promise<{ version: string }> {
		return this.requestJson('/api/v1/version');
	}

	async getCurrentUser(): Promise<GiteaUser> {
		return this.requestJson('/api/v1/user');
	}

	async getRepository(owner: string, repo: string): Promise<GiteaRepository> {
		return this.requestJson(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
	}

	async listPullRequests(owner: string, repo: string, state: GiteaPullRequestState = 'open'): Promise<GiteaPullRequest[]> {
		return this.requestJson(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&limit=50`);
	}

	async getPullRequest(owner: string, repo: string, index: number): Promise<GiteaPullRequest> {
		return this.requestJson(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}`);
	}

	async listPullRequestFiles(owner: string, repo: string, index: number): Promise<GiteaChangedFile[]> {
		try {
			const files = await this.requestJson<any[]>(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}/files`);
			return files.map(file => ({
				filename: file.filename ?? file.new_path,
				previousFilename: file.previous_filename ?? file.old_path,
				status: normalizeStatus(file.status),
				additions: file.additions,
				deletions: file.deletions,
				changes: file.changes,
				binary: !!file.binary,
			})).filter(file => !!file.filename);
		} catch (error) {
			const diff = await this.getPullRequestDiff(owner, repo, index);
			return parseDiffFileHeaders(diff);
		}
	}

	async getPullRequestDiff(owner: string, repo: string, index: number): Promise<string> {
		return this.requestText(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${index}.diff`);
	}

	async getFileContent(owner: string, repo: string, ref: string, path: string): Promise<string> {
		const encodedPath = path.split('/').map(encodeURIComponent).join('/');
		const response = await this.requestJson<any>(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
		if (response.type === 'file' && typeof response.content === 'string') {
			return Buffer.from(response.content.replace(/\n/g, ''), response.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
		}
		throw new Error(`Gitea content response for ${path} was not a file.`);
	}

	async createPullRequest(owner: string, repo: string, options: CreateGiteaPullRequestOptions): Promise<GiteaPullRequest> {
		return this.requestJson(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
			method: 'POST',
			body: JSON.stringify(options),
		});
	}

	private async requestJson<T>(path: string, init?: any): Promise<T> {
		const response = await this.request(path, init);
		return response.json() as Promise<T>;
	}

	private async requestText(path: string): Promise<string> {
		const response = await this.request(path);
		return response.text();
	}

	private async request(path: string, init?: any): Promise<any> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				'Accept': 'application/json',
				...(init?.body ? { 'Content-Type': 'application/json' } : {}),
				...authHeaders(this.auth),
				...(init?.headers ?? {}),
			},
		});
		if (!response.ok) {
			throw new Error(`Gitea API ${response.status} ${response.statusText}: ${await response.text()}`);
		}
		return response;
	}
}

function authHeaders(auth: GiteaAuth | undefined): Record<string, string> {
	if (!auth) {
		return {};
	}
	if (auth.type === 'token') {
		return { 'Authorization': `token ${auth.token}` };
	}
	return { 'Authorization': `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
}

function normalizeStatus(status: string | undefined): GiteaFileStatus {
	switch ((status ?? '').toLocaleLowerCase()) {
		case 'added':
		case 'created':
			return 'added';
		case 'removed':
		case 'deleted':
			return 'deleted';
		case 'renamed':
			return 'renamed';
		case 'copied':
			return 'copied';
		case 'changed':
		case 'modified':
			return 'modified';
		default:
			return 'unknown';
	}
}

function parseDiffFileHeaders(diff: string): GiteaChangedFile[] {
	const files: GiteaChangedFile[] = [];
	let current: GiteaChangedFile | undefined;
	for (const line of diff.split(/\r?\n/)) {
		const diffMatch = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
		if (diffMatch) {
			current = { filename: diffMatch[2], previousFilename: diffMatch[1] === diffMatch[2] ? undefined : diffMatch[1], status: 'modified' };
			files.push(current);
			continue;
		}
		if (!current) {
			continue;
		}
		if (line.startsWith('new file mode')) {
			current.status = 'added';
		} else if (line.startsWith('deleted file mode')) {
			current.status = 'deleted';
		} else if (line.startsWith('rename from ')) {
			current.previousFilename = line.substring('rename from '.length);
			current.status = 'renamed';
		} else if (line.startsWith('rename to ')) {
			current.filename = line.substring('rename to '.length);
		} else if (line.startsWith('Binary files ')) {
			current.binary = true;
			current.status = 'binary';
		}
	}
	return files;
}
