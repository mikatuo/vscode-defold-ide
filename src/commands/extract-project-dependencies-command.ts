import * as vscode from 'vscode';
import { config } from '../config';
import { constants } from '../constants';
import { IAsset, IState, StateMemento } from '../persistence/state-memento';
import { extendConfigArray, getWorkspacePath, readWorkspaceFile, removeFromConfigArray, safelyDeleteFolder, saveWorkspaceFile } from '../utils/common';
import { GameProjectConfig } from '../utils/game-project-config';
import { ZipArchiveManager } from '../utils/zip-archive-manager';

const skipAssets = [
    'extension-teal', // Defold editor shows an error when it's extracted
];

export async function registerUnzipProjectAssetsCommand(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('vscode-defold-ide.unzipDependencies', async (folder: vscode.Uri) => {
        const state = await StateMemento.load(context);
        if (!state) { return; } // initialization was not performed

        const filenames = await readArchivedAssetFilenames();
        if (assetAnnotationsAreUpToDate(state, filenames)) { return; }

        console.log('Extracting dependencies...');
        state.assets = [];
        await safelyDeleteFolder(config.assetsAnnotationsFolder, { recursive: true, useTrash: false });
        // remove .defold/lib/ from the library paths in the Lua plugin settings
        // a workaround to make the Lua plugin reload lib files after they change
        await removeLuaWorkspaceLibrariesFromSettings();
        for await (const filename of filenames) {
            const assetArchive = await readAssetArchiveMetadata(filename);
            if (shouldSkipAsset(assetArchive)) {
                console.log(`Skipping ${assetArchive.name} asset`);
                state.assets.push(toAssetInfo(assetArchive, filename));
                continue;
            }
            await unzipAssetFromArchive(assetArchive);
            await maybeEnhanceUnzippedAsset(assetArchive);
            // add .defold/lib/ into the library paths in the Lua plugin settings
            //await moveAssetIncludeFolderIntoAnnotationsFolder(unzippedAsset);
            state.assets.push(toAssetInfo(assetArchive, filename));
        }
        await deleteExtManifestFilesToNotHaveBuildErrors();
        //await deleteFilesFromAssetsFolder('.cpp');
        await addLuaWorkspaceLibrariesIntoSettings();
        await StateMemento.save(context, state);
	}));
};

async function readArchivedAssetFilenames() {
    try {
        const dependenciesInternalPath = getWorkspacePath(constants.assetsInternalFolder);
        const archiveFilenames = await vscode.workspace.fs.readDirectory(dependenciesInternalPath!);
        return archiveFilenames.filter(filename => filename[1] === vscode.FileType.File && filename[0].endsWith('.zip'));
    } catch (ex) {
        console.log('Failed to read archived assets.', ex);
        return [];
    }
}

function assetAnnotationsAreUpToDate(state: IState, filenames: [string, vscode.FileType][]) {
    if (state.assets.length !== filenames.length) {
        return false;
    }
    const existingAssetFilenames = state.assets.map(asset => asset.sourceArchiveFilename);
    const someAreDifferent = filenames.some(filename => !existingAssetFilenames.includes(filename[0]));
    const allAreUpToDate = !someAreDifferent;
    return allAreUpToDate;
}

async function removeLuaWorkspaceLibrariesFromSettings() {
    const workspaceConfig = vscode.workspace.getConfiguration();
    await removeFromConfigArray(workspaceConfig, 'Lua.workspace.library', x => x.startsWith(config.assetsAnnotationsFolder));
}

async function deleteExtManifestFilesToNotHaveBuildErrors() {
    // delete 'ext.manifest' files otherwise they cause errors when bundling
    const files = await vscode.workspace.findFiles('.defold/assets/**/ext.manifest');
    for (const file of files) {
        await vscode.workspace.fs.delete(file);
    }
}

async function addLuaWorkspaceLibrariesIntoSettings() {
    const workspaceConfig = vscode.workspace.getConfiguration();
    await extendConfigArray(workspaceConfig, 'Lua.workspace.library', [config.assetsAnnotationsFolder]);
}

async function maybeEnhanceUnzippedAsset(unzippedAsset: IArchiveAsset) {
    if (!unzippedAsset || !unzippedAsset.name) {
        return;
    }
    const assetsAnnotationsUri = getWorkspacePath(config.assetsAnnotationsFolder)!;
    switch (unzippedAsset.name.toLowerCase()) {
        case 'druid':
            const path = vscode.Uri.joinPath(assetsAnnotationsUri, unzippedAsset.includeDirectories[0], 'druid.lua');
            await safelyEditAssetFile(path, (content: string) => {
                return content.replace('local M = {}', 'local M = {} ---@type druid');
            });
            break;
        default:
            break;
    }
}

async function safelyEditAssetFile(path: vscode.Uri, mutator: (content: string) => string) {
    try {
        let fileContent = await readWorkspaceFile(path);
        fileContent = mutator(fileContent!);
        await saveWorkspaceFile(path, fileContent);
    } catch (ex) {
        console.error(`Failed to edit an unzipped asset file ${path.fsPath}.`, ex);
    }
}

async function readAssetArchiveMetadata(filename: [string, vscode.FileType]): Promise<IArchiveAsset> {
    const zipUri = getWorkspacePath(`${constants.assetsInternalFolder}/${filename[0]}`)!;
    return await readAssetInfoFromArchive(zipUri.fsPath);
}

function shouldSkipAsset(archivedAsset: IArchiveAsset): boolean {
    const assetName = archivedAsset.rootDirectory?.toLowerCase() || archivedAsset.name.toLowerCase();
    return skipAssets.findIndex(name => assetName.startsWith(name)) !== -1;
}

async function unzipAssetFromArchive(archivedAsset: IArchiveAsset): Promise<void> {
    const destinationUri = getWorkspacePath(config.assetsAnnotationsFolder)!;
    
    // unzip the asset into /.defold/lib/{asset-name}/include-dir
    try {
        const includeDirs = getIncludeDirsInsideArchive(archivedAsset);
        const archiveManager = new ZipArchiveManager(archivedAsset.path);
        await archiveManager.extractEntries(
            entry => includeDirs.includes(entry.relativePath),
            destinationUri,
            { overwrite: true },
        );
    } catch (ex) {
        console.error(`Failed to unzip asset '${archivedAsset.name}' from archive ${archivedAsset.path}`, ex);
    }
}

function getIncludeDirsInsideArchive(archivedAsset: IArchiveAsset): string[] {
    return archivedAsset.includeDirectories.map(includeDir => {
        if (archivedAsset.rootDirectory !== '') {
            return `${archivedAsset.rootDirectory}/${includeDir}/`;
        } else {
            return `${includeDir.trim()}/`;
        }
    });
}

function toAssetInfo(unzippedAsset: IArchiveAsset, filename: [string, vscode.FileType]): IAsset {
    return {
        name: unzippedAsset.name,
        version: unzippedAsset.version,
        sourceArchiveFilename: filename[0],
    };
}

async function readAssetInfoFromArchive(path: string): Promise<IArchiveAsset> {
    try {
        const archiveManager = new ZipArchiveManager(path);
        const data = await archiveManager.readAsText('game.project');
        const config = GameProjectConfig.fromString(data!);
        return {
            path,
            name: config.title(),
            version: config.version(),
            rootDirectory: archiveManager.rootDirectory || '',
            includeDirectories: config.libraryIncludeDirs(),
        };
    } catch (e) {
        console.log(`Failed to read asset info from the archive. ${e}`);
        return {} as IArchiveAsset;
    }
}

interface IArchiveAsset {
    path: string;
    name: string;
    version: string;
    rootDirectory: string;
    includeDirectories: string[];
}
