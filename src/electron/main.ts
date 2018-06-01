import * as Analyzer from '../server/analyzer';
import { checkForUpdates } from './auto-updater';
import { Color } from '../components';
import { createCompiler } from '../server/compiler/create-compiler';
import { createApplicationMenu } from './create-application-menu';
import { createElementContexMenu } from './create-element-context-menu';
import { app, BrowserWindow, dialog, screen } from 'electron';
import * as electronIsDev from 'electron-is-dev';
import * as Fs from 'fs';
import * as getPort from 'get-port';
import { isEqual, uniqWith } from 'lodash';
import { PreviewMessageType, ServerMessage, ServerMessageType } from '../message';
import * as MimeTypes from 'mime-types';
import { Project } from '../model';
import * as Path from 'path';
import { Persistence, PersistenceState } from '../server/persistence';
import { Sender } from '../message/server';
import { createServer } from '../server/server';
import * as Types from '../model/types';
import * as Util from 'util';
import * as uuid from 'uuid';

const ElectronStore = require('electron-store');

// const APP_ENTRY = require.resolve('./renderer');

const showOpenDialog = (options: Electron.OpenDialogOptions): Promise<string[]> =>
	new Promise(resolve => dialog.showOpenDialog(options, resolve));

const showSaveDialog = (options: Electron.SaveDialogOptions): Promise<string | undefined> =>
	new Promise(resolve => dialog.showSaveDialog(options, resolve));

const readFile = Util.promisify(Fs.readFile);
const writeFile = Util.promisify(Fs.writeFile);

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win: BrowserWindow | undefined;

let projectPath: string | undefined;

const userStore = new ElectronStore();

const sender = new Sender();

// Cast getPort return type from PromiseLike<number> to Promise<number>
// to avoid async-promise tslint rule to produce errors here
const starting = (async () => {
	const port = await (getPort({ port: 1879 }) as Promise<number>);
	const server = await createServer({ port });
	return { server, port };
})();

async function createWindow(): Promise<void> {
	const { width = 1280, height = 800 } = screen.getPrimaryDisplay().workAreaSize;
	const { server, port } = await starting;

	// Create the browser window.
	win = new BrowserWindow({
		width,
		height,
		minWidth: 780,
		minHeight: 380,
		titleBarStyle: 'hiddenInset',
		backgroundColor: Color.Grey97,
		title: 'Alva',
		webPreferences: {
			nodeIntegration: false
		}
	});

	// and load the index.html of the app.
	win.loadURL(`http://localhost:${port}/index.html`);

	const send = (message: ServerMessage): void => {
		server.emit('message', message);
	};

	sender.receive(async message => {
		if (!message) {
			return;
		}

		send(message);

		// Handle messages that require
		// access to system / fs
		// tslint:disable-next-line:cyclomatic-complexity
		switch (message.type) {
			case ServerMessageType.CheckForUpdatesRequest: {
				if (win) {
					checkForUpdates(win, true);
				}
				break;
			}
			case ServerMessageType.AppLoaded: {
				// Load last known file automatically in development
				if (electronIsDev && projectPath) {
					const result = await Persistence.read<Types.SavedProject>(projectPath);

					if (result.state === PersistenceState.Error) {
						// TODO: Show user facing error here
					} else {
						const contents = result.contents as Types.SerializedProject;
						contents.path = projectPath;

						send({
							type: ServerMessageType.OpenFileResponse,
							id: message.id,
							payload: { path: projectPath, contents }
						});
					}
				}

				send({
					id: uuid.v4(),
					type: ServerMessageType.StartApp,
					payload: String(port)
				});

				break;
			}
			case ServerMessageType.CreateNewFileRequest: {
				const path = await showSaveDialog({
					title: 'Create New Alva File',
					defaultPath: 'Untitled Project.alva',
					filters: [
						{
							name: 'Alva File',
							extensions: ['alva']
						}
					]
				});

				if (electronIsDev) {
					projectPath = path;
				}

				if (path) {
					const project = Project.create({
						name: 'Untitled Project',
						path
					});

					await Persistence.persist(path, project);

					send({
						type: ServerMessageType.CreateNewFileResponse,
						id: message.id,
						payload: {
							path,
							contents: project.toJSON()
						}
					});
				}
				break;
			}
			case ServerMessageType.OpenFileRequest: {
				const paths = await showOpenDialog({
					title: 'Open Alva File',
					properties: ['openFile'],
					filters: [
						{
							name: 'Alva File',
							extensions: ['alva']
						}
					]
				});

				const path = Array.isArray(paths) ? paths[0] : undefined;

				if (electronIsDev) {
					projectPath = path;
				}

				if (path) {
					const result = await Persistence.read<Types.SavedProject>(path);

					if (result.state === PersistenceState.Error) {
						// TODO: Show user facing error here
					} else {
						const contents = result.contents as Types.SerializedProject;
						contents.path = path;

						send({
							type: ServerMessageType.OpenFileResponse,
							id: message.id,
							payload: { path, contents }
						});
					}
				}
				break;
			}
			case ServerMessageType.AssetReadRequest: {
				const paths = await showOpenDialog({
					title: 'Select an image',
					properties: ['openFile']
				});

				if (!paths) {
					return;
				}

				const path = paths[0];

				if (!path) {
					return;
				}

				// TODO: Handle errors
				const content = await readFile(path);
				const mimeType = MimeTypes.lookup(path) || 'application/octet-stream';

				send({
					type: ServerMessageType.AssetReadResponse,
					id: message.id,
					payload: `data:${mimeType};base64,${content.toString('base64')}`
				});

				break;
			}
			case ServerMessageType.Save: {
				const project = Project.from(message.payload.project);
				project.setPath(message.payload.path);
				if (process.env.NODE_ENV === 'development') {
					projectPath = project.getPath();
				}

				await Persistence.persist(project.getPath(), project);
				break;
			}
			case ServerMessageType.CreateScriptBundleRequest: {
				const compiler = createCompiler([], { cwd: process.cwd(), infrastructure: true });

				compiler.run(err => {
					if (err) {
						// TODO: Handle errrors
						return;
					}

					const outputFileSystem = compiler.outputFileSystem;

					send({
						type: ServerMessageType.CreateScriptBundleResponse,
						id: message.id,
						payload: ['renderer', 'preview']
							.map(name => ({ name, path: Path.posix.join('/', `${name}.js`) }))
							.map(({ name, path }) => ({
								name,
								path,
								contents: outputFileSystem.readFileSync(path)
							}))
					});
				});

				break;
			}
			case ServerMessageType.ExportHTML:
			case ServerMessageType.ExportPDF:
			case ServerMessageType.ExportPNG:
			case ServerMessageType.ExportSketch: {
				const { path, content } = message.payload;
				writeFile(path, content);
				break;
			}
			case ServerMessageType.ConnectPatternLibraryRequest: {
				const paths = await showOpenDialog({
					title: 'Connnect Pattern Library',
					properties: ['openDirectory']
				});

				const path = Array.isArray(paths) ? paths[0] : undefined;

				if (!path) {
					return;
				}

				const project = Project.from(message.payload);
				const library = project.getPatternLibrary();

				const analysis = await Analyzer.analyze(path, {
					getGobalEnumOptionId: (patternId, contextId) =>
						library.assignEnumOptionId(patternId, contextId),
					getGlobalPatternId: contextId => library.assignPatternId(contextId),
					getGlobalPropertyId: (patternId, contextId) =>
						library.assignPropertyId(patternId, contextId),
					getGlobalSlotId: (patternId, contextId) => library.assignSlotId(patternId, contextId)
				});

				send({
					type: ServerMessageType.ConnectPatternLibraryResponse,
					id: message.id,
					payload: analysis
				});

				break;
			}
			case ServerMessageType.UpdatePatternLibraryRequest: {
				const project = Project.from(message.payload);
				const library = project.getPatternLibrary();
				const id = library.getId();

				const connections = userStore.get('connections') || [];

				const connection = connections
					.filter(
						c =>
							typeof c === 'object' && typeof c.path === 'string' && typeof c.id === 'string'
					)
					.find(c => c.id === id);

				if (!connection) {
					return;
				}

				const analysis = await Analyzer.analyze(connection.path, {
					getGobalEnumOptionId: (patternId, contextId) =>
						library.assignEnumOptionId(patternId, contextId),
					getGlobalPatternId: contextId => library.assignPatternId(contextId),
					getGlobalPropertyId: (patternId, contextId) =>
						library.assignPropertyId(patternId, contextId),
					getGlobalSlotId: (patternId, contextId) => library.assignSlotId(patternId, contextId)
				});

				send({
					type: ServerMessageType.ConnectPatternLibraryResponse,
					id: message.id,
					payload: analysis
				});

				break;
			}
			case ServerMessageType.ConnectedPatternLibraryNotification: {
				// Save connections between Alva files and pattern library folders
				// in user-specific persistence
				const previous = userStore.get('connections') || [];
				const previousConnections = (Array.isArray(previous) ? previous : [previous]).filter(
					p => typeof p === 'object' && typeof p.path === 'string' && typeof p.id === 'string'
				);

				const connections = uniqWith([...previousConnections, message.payload], isEqual);
				userStore.set('connections', connections);

				break;
			}
			case ServerMessageType.CheckLibraryRequest: {
				const connections = userStore.get('connections') || [];

				connections.filter(c => c.id === message.payload.id).forEach(connection => {
					Fs.exists(connection.path, async exists => {
						send({
							id: message.id,
							type: ServerMessageType.CheckLibraryResponse,
							payload: [
								{
									id: connection.id,
									path: connection.path,
									connected: exists
								}
							]
						});
					});
				});
				break;
			}
			case ServerMessageType.UpdateMenu: {
				createApplicationMenu(message.payload, { sender });
				break;
			}
			case ServerMessageType.ContextElementMenuRequest: {
				createElementContexMenu(message.payload, { sender });
			}
		}
	});

	server.on('alva-message', message => sender.emit(message));

	// Handle messages from preview
	server.on('client-message', (envelope: string) => {
		try {
			const message = JSON.parse(envelope);

			switch (message.type) {
				case PreviewMessageType.ContentResponse: {
					sender.send({
						id: message.id,
						payload: message.payload,
						type: ServerMessageType.ContentResponse
					});
					break;
				}
				case PreviewMessageType.SketchExportResponse: {
					sender.send({
						id: message.id,
						payload: message.payload,
						type: ServerMessageType.SketchExportResponse
					});
					break;
				}
				case PreviewMessageType.SelectElement: {
					sender.send({
						id: message.id,
						payload: message.payload,
						type: ServerMessageType.SelectElement
					});
					break;
				}
				case PreviewMessageType.UnselectElement: {
					sender.send({
						id: message.id,
						payload: undefined,
						type: ServerMessageType.UnselectElement
					});
					break;
				}
				case PreviewMessageType.HighlightElement: {
					sender.send({
						id: message.id,
						payload: message.payload,
						type: ServerMessageType.HighlightElement
					});
				}
			}
		} catch (err) {
			console.error('Error while receiving client message');
			console.error(err);
		}
	});

	// Open the DevTools.
	// win.webContents.openDevTools();

	// Emitted when the window is closed.
	win.on('closed', () => {
		// Dereference the window object, usually you would store windows
		// in an array if your app supports multi windows, this is the time
		// when you should delete the corresponding element.
		win = undefined;
	});

	// Disable navigation on the host window object, triggered by system drag and drop
	win.webContents.on('will-navigate', e => {
		e.preventDefault();
	});

	// Install development tools in dev mode
	if (electronIsDev) {
		const {
			REACT_DEVELOPER_TOOLS,
			REACT_PERF,
			MOBX_DEVTOOLS
		} = require('electron-devtools-installer');
		const installDevTool = require('electron-devtools-installer').default;

		await installDevTool(REACT_DEVELOPER_TOOLS);
		await installDevTool(REACT_PERF);
		await installDevTool(MOBX_DEVTOOLS);
	}

	checkForUpdates(win);
}

const log = require('electron-log');
log.info('App starting...');

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
	await createWindow();
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
	// On macOS it is common for applications and their menu bar
	// to stay active until the user quits explicitly with Cmd + Q
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('activate', async () => {
	// On macOS it's common to re-create a window in the app when the
	// dock icon is clicked and there are no other windows open.
	if (!win) {
		await createWindow();
	}
});

process.on('unhandledRejection', reason => {
	console.error(reason);
});
