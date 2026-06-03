/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GiteaAuth } from './config';
import { GiteaClient } from './giteaClient';

export const GITEA_CONTENT_SCHEME = 'gitea-pr';

export interface GiteaContentUriParams {
	baseUrl: string;
	auth?: GiteaAuth;
	owner: string;
	repo: string;
	ref?: string;
	path: string;
	empty?: boolean;
	binary?: boolean;
}

export class GiteaContentProvider implements vscode.TextDocumentContentProvider {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const params = JSON.parse(uri.query) as GiteaContentUriParams;
		if (params.empty) {
			return '';
		}
		if (params.binary) {
			return 'Binary file';
		}
		if (!params.ref) {
			return '';
		}
		const client = new GiteaClient(params.baseUrl, params.auth);
		return client.getFileContent(params.owner, params.repo, params.ref, params.path);
	}
}

export function toGiteaContentUri(params: GiteaContentUriParams): vscode.Uri {
	return vscode.Uri.from({
		scheme: GITEA_CONTENT_SCHEME,
		path: `/${params.path}`,
		query: JSON.stringify(params),
	});
}
