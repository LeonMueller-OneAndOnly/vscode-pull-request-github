/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitApiImpl } from './api/api1';
import Logger from './common/logger';
import { EXTENSION_ID } from './constants';
import { initializeGiteaConfigSecrets } from './gitea/config';
import { GITEA_CONTENT_SCHEME, GiteaContentProvider } from './gitea/giteaContentProvider';
import { GiteaChangesProvider, GiteaPullRequestsProvider, registerGiteaTreeCommands } from './gitea/giteaTree';
import { registerBuiltinGitProvider } from './gitProviders/api';

const ACTIVATION = 'Activation';

export async function activate(context: vscode.ExtensionContext): Promise<GitApiImpl> {
	Logger.appendLine(`Extension version: ${vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.version}`, ACTIVATION);
	context.subscriptions.push(Logger);
	initializeGiteaConfigSecrets(context.secrets);

	const git = new GitApiImpl(undefined as any);
	context.subscriptions.push(git);

	const builtInGitProvider = await registerBuiltinGitProvider(undefined as any, git);
	if (builtInGitProvider) {
		context.subscriptions.push(builtInGitProvider);
	} else {
		vscode.window.showWarningMessage(vscode.l10n.t('Gitea Pull Requests requires the built-in Git extension.'));
	}

	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(GITEA_CONTENT_SCHEME, new GiteaContentProvider()));

	const changesProvider = new GiteaChangesProvider();
	const pullRequestsProvider = new GiteaPullRequestsProvider(git, selected => changesProvider.setPullRequest(selected));
	context.subscriptions.push(
		vscode.window.createTreeView('gitea:pullRequests', { treeDataProvider: pullRequestsProvider, showCollapseAll: true }),
		vscode.window.createTreeView('gitea:changes', { treeDataProvider: changesProvider, showCollapseAll: true }),
	);
	registerGiteaTreeCommands(context, pullRequestsProvider, changesProvider);

	git.onDidOpenRepository(() => pullRequestsProvider.refresh());
	git.onDidCloseRepository(() => pullRequestsProvider.refresh());
	git.onDidChangeState(() => pullRequestsProvider.refresh());

	await vscode.commands.executeCommand('setContext', 'gitea:initialized', true);
	await pullRequestsProvider.refresh();
	return git;
}

export async function deactivate() { }
