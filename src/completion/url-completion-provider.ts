import * as vscode from 'vscode';
import { readWorkspaceFileBytes } from '../utils/common';
import { DefoldIndex, IDefoldComponent, IDefoldInstance } from '../utils/defold-file-indexer';

export async function registerUrlCompletionItemProvider(context: vscode.ExtensionContext) {
    const urlCompletion = vscode.languages.registerCompletionItemProvider('lua', {
        provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext) {
			if (!showUrlCompletion(document, position)) { return undefined; }
			const script = vscode.workspace.asRelativePath(document.uri);

			// TODO: when an autocomplete is selected then add hash at the beginning of the file
			// TODO: identify collection proxies and provide completion for them
			// TODO: identify if a script is attached to a game object or collection created by a factory
			// TODO: then if the factory is placed inside a collection then provide completion for that collection
			const items = completionIfAttachedToGameObject(script).concat(completionIfAttachedToCollection(script));
			if (items.length) {
				return items;
			} else {
				return undefined;
			}
        },
    }, '"', ':');
    
	context.subscriptions.push(urlCompletion);
}

function showUrlCompletion(document: vscode.TextDocument, position: vscode.Position): boolean {
	if (!document.uri.path.endsWith('.script')) {
		return false;
	}
	
	const linePrefix = document.lineAt(position).text.substring(0, position.character);
	if (linePrefix.endsWith('"') || linePrefix.endsWith('"#') || /"\w+:$/.test(linePrefix)) {
		return true;
	}

	return false;
}

function completionIfAttachedToGameObject(scriptPath: string): vscode.CompletionItem[] {
	const components = DefoldIndex.instance.findGameObjectComponents(`/${scriptPath}`);
	return components.map(componentCompletionItem);
}

function completionIfAttachedToCollection(script: string): vscode.CompletionItem[] {
	const instances = DefoldIndex.instance.findCollectionInstances(`/${script}`);
	return instances.flatMap(instanceCompletionItem);
}

function instanceCompletionItem(instance: IDefoldInstance): vscode.CompletionItem[] {
	const item = new vscode.CompletionItem({
		label: instance.url,
		detail: ` ${instance.type}`,
		description: instance.filename,
	}, vscode.CompletionItemKind.Text);
	item.filterText = instance.url;

	return [
		item,
		...[...instance.instances].flatMap(instanceCompletionItem),
		...instance.components.map(componentCompletionItem),
	];
}

function componentCompletionItem(component: IDefoldComponent): vscode.CompletionItem {
	const item = new vscode.CompletionItem({
		label: component.url,
		detail: ` ${component.type}`,
		description: component.filename,
	}, vscode.CompletionItemKind.Text);
	item.filterText = component.id;
	return item;
}
