/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { deleteGiteaAuth, getGiteaInstances, GITEA_SETTINGS_NAMESPACE, normalizeBaseUrl, storeGiteaBasicAuth } from './config';
import { GiteaChangedFile, GiteaClient, GiteaPullRequest } from './giteaClient';
import { GiteaContentUriParams, toGiteaContentUri } from './giteaContentProvider';
import { findGiteaRepository, GiteaRepositoryMatch } from './giteaRepositoryDetector';
import { IGit } from '../api/api';

type PrCategory = 'open' | 'closed';

export interface SelectedGiteaPullRequest {
	match: GiteaRepositoryMatch;
	client: GiteaClient;
	pullRequest: GiteaPullRequest;
}

export class GiteaPullRequestsProvider implements vscode.TreeDataProvider<GiteaTreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<GiteaTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private matches: GiteaRepositoryMatch[] = [];
	private prs = new Map<string, { open?: GiteaPullRequest[]; closed?: GiteaPullRequest[] }>();

	constructor(private readonly git: IGit, private readonly onDidSelectPullRequest: (selected: SelectedGiteaPullRequest) => void) { }

	getMatches(): GiteaRepositoryMatch[] {
		return this.matches;
	}

	async refresh(): Promise<void> {
		const matches = await Promise.all(this.git.repositories.map(findGiteaRepository));
		this.matches = uniqueMatches(matches.filter((match): match is GiteaRepositoryMatch => !!match));
		this.prs.clear();
		this._onDidChangeTreeData.fire(undefined);
		await Promise.all(this.matches.map(async match => {
			const client = new GiteaClient(match.instance.baseUrl, match.instance.auth);
			const [openResult, closedResult] = await Promise.allSettled([
				client.listPullRequests(match.owner, match.repo, 'open'),
				client.listPullRequests(match.owner, match.repo, 'closed'),
			]);
			const open = openResult.status === 'fulfilled' ? openResult.value : [];
			const closed = closedResult.status === 'fulfilled' ? closedResult.value : [];
			this.prs.set(keyForMatch(match), { open, closed });
		}));
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: GiteaTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: GiteaTreeItem): Promise<GiteaTreeItem[]> {
		if (!element) {
			if (!this.matches.length) {
				return [new MessageNode('Sign in to Gitea to show pull request repositories')];
			}
			return this.matches.map(match => new RepositoryNode(match));
		}
		if (element instanceof RepositoryNode) {
			return [new CategoryNode(element.match, 'open'), new CategoryNode(element.match, 'closed')];
		}
		if (element instanceof CategoryNode) {
			const prs = this.prs.get(keyForMatch(element.match))?.[element.category] ?? [];
			return prs.map(pr => new PullRequestNode(element.match, pr, this.onDidSelectPullRequest));
		}
		return [];
	}
}

export class GiteaChangesProvider implements vscode.TreeDataProvider<GiteaTreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<GiteaTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private selected: SelectedGiteaPullRequest | undefined;
	private files: GiteaChangedFile[] = [];

	async setPullRequest(selected: SelectedGiteaPullRequest): Promise<void> {
		this.selected = selected;
		this.files = await selected.client.listPullRequestFiles(selected.match.owner, selected.match.repo, selected.pullRequest.number);
		this._onDidChangeTreeData.fire(undefined);
	}

	async refresh(): Promise<void> {
		if (this.selected) {
			await this.setPullRequest(this.selected);
		} else {
			this._onDidChangeTreeData.fire(undefined);
		}
	}

	getTreeItem(element: GiteaTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: GiteaTreeItem): GiteaTreeItem[] {
		if (!this.selected) {
			return [new MessageNode('Select a Gitea pull request to view changed files')];
		}
		if (!element) {
			return buildFileTree(this.selected, this.files);
		}
		if (element instanceof FolderNode) {
			return element.children;
		}
		return [];
	}
}

export type GiteaTreeItem = MessageNode | RepositoryNode | CategoryNode | PullRequestNode | FolderNode | FileNode;

class MessageNode extends vscode.TreeItem {
	constructor(message: string) {
		super(message, vscode.TreeItemCollapsibleState.None);
	}
}

class RepositoryNode extends vscode.TreeItem {
	constructor(readonly match: GiteaRepositoryMatch) {
		super(`${match.owner}/${match.repo}`, vscode.TreeItemCollapsibleState.Expanded);
		this.description = match.instance.baseUrl;
		this.iconPath = new vscode.ThemeIcon('repo');
	}
}

class CategoryNode extends vscode.TreeItem {
	constructor(readonly match: GiteaRepositoryMatch, readonly category: PrCategory) {
		super(category === 'open' ? 'Open Pull Requests' : 'Closed Pull Requests', vscode.TreeItemCollapsibleState.Expanded);
		this.iconPath = new vscode.ThemeIcon(category === 'open' ? 'git-pull-request' : 'git-pull-request-closed');
	}
}

class PullRequestNode extends vscode.TreeItem {
	constructor(readonly match: GiteaRepositoryMatch, readonly pullRequest: GiteaPullRequest, select: (selected: SelectedGiteaPullRequest) => void) {
		super(`#${pullRequest.number} ${pullRequest.title}`, vscode.TreeItemCollapsibleState.None);
		this.description = `${pullRequest.user?.login ?? 'unknown'} • ${pullRequest.head.ref} → ${pullRequest.base.ref}`;
		this.tooltip = pullRequest.html_url;
		this.iconPath = new vscode.ThemeIcon(pullRequest.state === 'open' ? 'git-pull-request' : 'git-pull-request-closed');
		this.contextValue = 'giteaPullRequest';
		this.command = {
			command: 'giteaPullRequests.selectPullRequest',
			title: 'Select Pull Request',
			arguments: [{ match, client: new GiteaClient(match.instance.baseUrl, match.instance.auth), pullRequest }, select],
		};
	}
}

class FolderNode extends vscode.TreeItem {
	constructor(label: string, readonly children: GiteaTreeItem[]) {
		super(label, vscode.TreeItemCollapsibleState.Expanded);
		this.iconPath = new vscode.ThemeIcon('folder');
	}
}

class FileNode extends vscode.TreeItem {
	constructor(readonly selected: SelectedGiteaPullRequest, readonly file: GiteaChangedFile) {
		super(file.filename.split('/').pop()!, vscode.TreeItemCollapsibleState.None);
		this.description = statusLabel(file);
		this.resourceUri = vscode.Uri.file(file.filename);
		this.iconPath = new vscode.ThemeIcon(iconForStatus(file));
		this.contextValue = 'giteaChangedFile';
		this.command = {
			command: 'giteaPullRequests.openDiff',
			title: 'Open Diff',
			arguments: [selected, file],
		};
	}
}

export async function openGiteaDiff(selected: SelectedGiteaPullRequest, file: GiteaChangedFile): Promise<void> {
	const pr = selected.pullRequest;
	const common: Omit<GiteaContentUriParams, 'path'> = {
		baseUrl: selected.match.instance.baseUrl,
		auth: selected.match.instance.auth,
		owner: selected.match.owner,
		repo: selected.match.repo,
	};
	const basePath = file.previousFilename ?? file.filename;
	const headPath = file.filename;
	const baseUri = toGiteaContentUri({ ...common, path: basePath, ref: pr.base.sha || pr.base.ref, empty: file.status === 'added', binary: file.binary });
	const headUri = toGiteaContentUri({ ...common, path: headPath, ref: pr.head.sha || pr.head.ref, empty: file.status === 'deleted', binary: file.binary });
	await vscode.commands.executeCommand('vscode.diff', baseUri, headUri, `#${pr.number} ${basePath}${basePath === headPath ? '' : ` → ${headPath}`}`);
}

function buildFileTree(selected: SelectedGiteaPullRequest, files: GiteaChangedFile[]): GiteaTreeItem[] {
	const root = new Map<string, any>();
	for (const file of files.sort((a, b) => a.filename.localeCompare(b.filename))) {
		let level = root;
		const parts = file.filename.split('/');
		for (const part of parts.slice(0, -1)) {
			if (!level.has(part)) {
				level.set(part, new Map<string, any>());
			}
			level = level.get(part);
		}
		level.set(parts[parts.length - 1], new FileNode(selected, file));
	}
	return mapToNodes(root);
}

function mapToNodes(map: Map<string, any>): GiteaTreeItem[] {
	return Array.from(map.entries()).map(([name, value]) => value instanceof Map ? new FolderNode(name, mapToNodes(value)) : value);
}

function keyForMatch(match: GiteaRepositoryMatch): string {
	return `${match.instance.baseUrl}/${match.owner}/${match.repo}`;
}

function uniqueMatches(matches: GiteaRepositoryMatch[]): GiteaRepositoryMatch[] {
	const seen = new Set<string>();
	return matches.filter(match => {
		const key = keyForMatch(match).toLocaleLowerCase();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function statusLabel(file: GiteaChangedFile): string {
	return file.previousFilename && file.status === 'renamed' ? `renamed from ${file.previousFilename}` : file.status;
}

function iconForStatus(file: GiteaChangedFile): string {
	switch (file.status) {
		case 'added': return 'diff-added';
		case 'deleted': return 'diff-removed';
		case 'renamed': return 'diff-renamed';
		default: return 'diff-modified';
	}
}

export function registerGiteaTreeCommands(context: vscode.ExtensionContext, prProvider: GiteaPullRequestsProvider, changesProvider: GiteaChangesProvider): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('giteaPullRequests.refresh', async () => {
			await prProvider.refresh();
			await changesProvider.refresh();
		}),
		vscode.commands.registerCommand('giteaPullRequests.selectPullRequest', async (selected: SelectedGiteaPullRequest) => changesProvider.setPullRequest(selected)),
		vscode.commands.registerCommand('giteaPullRequests.openDiff', async (selectedOrNode: SelectedGiteaPullRequest | FileNode, file?: GiteaChangedFile) => {
			if (selectedOrNode instanceof FileNode) {
				return openGiteaDiff(selectedOrNode.selected, selectedOrNode.file);
			}
			return openGiteaDiff(selectedOrNode, file!);
		}),
		vscode.commands.registerCommand('giteaPullRequests.openInBrowser', async (node?: PullRequestNode) => {
			if (node?.pullRequest?.html_url) {
				await vscode.env.openExternal(vscode.Uri.parse(node.pullRequest.html_url));
			}
		}),
		vscode.commands.registerCommand('giteaPullRequests.signIn', async () => signInToGitea(prProvider)),
		vscode.commands.registerCommand('giteaPullRequests.signOut', async () => signOutOfGitea(prProvider)),
		vscode.commands.registerCommand('giteaPullRequests.createPullRequest', async () => createGiteaPullRequest(prProvider)),
		vscode.workspace.onDidChangeConfiguration(async event => {
			if (event.affectsConfiguration(GITEA_SETTINGS_NAMESPACE)) {
				await prProvider.refresh();
			}
		}),
	);
}

async function signInToGitea(prProvider: GiteaPullRequestsProvider): Promise<void> {
	const url = await vscode.window.showInputBox({
		title: 'Sign in to Gitea',
		prompt: 'Gitea instance URL',
		placeHolder: 'https://git.flow-office.eu',
		ignoreFocusOut: true,
	});
	if (!url) {
		return;
	}
	const username = await vscode.window.showInputBox({ title: 'Sign in to Gitea', prompt: 'Username', ignoreFocusOut: true });
	if (!username) {
		return;
	}
	const password = await vscode.window.showInputBox({ title: 'Sign in to Gitea', prompt: 'Password', password: true, ignoreFocusOut: true });
	if (!password) {
		return;
	}
	const baseUrl = normalizeBaseUrl(url);
	await storeGiteaBasicAuth(baseUrl, username, password);
	await ensureInstanceInSettings(baseUrl);
	await prProvider.refresh();
	await vscode.window.showInformationMessage(`Signed in to ${baseUrl}.`);
}

async function signOutOfGitea(prProvider: GiteaPullRequestsProvider): Promise<void> {
	const instances = await getGiteaInstances();
	const picked = await vscode.window.showQuickPick(instances.map(instance => instance.baseUrl), { placeHolder: 'Select Gitea instance to sign out' });
	if (!picked) {
		return;
	}
	await deleteGiteaAuth(picked);
	await prProvider.refresh();
	await vscode.window.showInformationMessage(`Signed out of ${picked}.`);
}

async function createGiteaPullRequest(prProvider: GiteaPullRequestsProvider): Promise<void> {
	await prProvider.refresh();
	const matches = prProvider.getMatches();
	if (!matches.length) {
		await vscode.window.showWarningMessage('No Gitea repositories were detected. Sign in or configure giteaPullRequests.instances, then refresh.');
		return;
	}
	const picked = matches.length === 1 ? matches[0] : await pickRepositoryMatch(matches);
	if (!picked) {
		return;
	}
	const branch = picked.repository.state.HEAD?.name;
	if (!branch) {
		await vscode.window.showWarningMessage('Current Git branch could not be detected.');
		return;
	}
	const client = new GiteaClient(picked.instance.baseUrl, picked.instance.auth);
	let repo;
	try {
		repo = await client.getRepository(picked.owner, picked.repo);
	} catch (error) {
		await vscode.window.showErrorMessage(`Unable to read Gitea repository: ${error.message}`);
		return;
	}
	const base = await vscode.window.showInputBox({
		title: 'Create Gitea Pull Request',
		prompt: 'Base branch',
		value: repo.default_branch ?? 'main',
		ignoreFocusOut: true,
	});
	if (!base) {
		return;
	}
	const title = await vscode.window.showInputBox({
		title: 'Create Gitea Pull Request',
		prompt: 'Pull request title',
		value: branch,
		ignoreFocusOut: true,
	});
	if (!title) {
		return;
	}
	const body = await vscode.window.showInputBox({
		title: 'Create Gitea Pull Request',
		prompt: 'Pull request description (optional)',
		ignoreFocusOut: true,
	});
	try {
		const pr = await client.createPullRequest(picked.owner, picked.repo, { title, body, head: branch, base });
		await prProvider.refresh();
		const open = 'Open in Browser';
		const result = await vscode.window.showInformationMessage(`Created Gitea pull request #${pr.number}.`, open);
		if (result === open) {
			await vscode.env.openExternal(vscode.Uri.parse(pr.html_url));
		}
	} catch (error) {
		await vscode.window.showErrorMessage(`Unable to create Gitea pull request: ${error.message}`);
	}
}

async function pickRepositoryMatch(matches: GiteaRepositoryMatch[]): Promise<GiteaRepositoryMatch | undefined> {
	const picked = await vscode.window.showQuickPick(matches.map(match => ({
		label: `${match.owner}/${match.repo}`,
		description: match.instance.baseUrl,
		match,
	})), { placeHolder: 'Select Gitea repository' });
	return picked?.match;
}

async function ensureInstanceInSettings(baseUrl: string): Promise<void> {
	const config = vscode.workspace.getConfiguration(GITEA_SETTINGS_NAMESPACE);
	const existing = config.get<{ url: string; token?: string }[]>('instances', []);
	if (existing.some(instance => normalizeBaseUrl(instance.url) === baseUrl)) {
		return;
	}
	await config.update('instances', [...existing, { url: baseUrl }], vscode.ConfigurationTarget.Global);
}
