/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	createConnection, IConnection,
	ResponseError, RequestType, RequestHandler, NotificationType, NotificationHandler,
	InitializeResult, InitializeError,
	Diagnostic, DiagnosticSeverity, Position, Range, Files,
	TextDocuments, TextDocument, TextDocumentSyncKind, TextEdit,
	Command, MessageActionItem,
	ErrorMessageTracker, IPCMessageReader, IPCMessageWriter
} from 'vscode-languageserver';

import fs = require('fs');
import path = require('path');
import { exec, fork, ChildProcess } from 'child_process';

interface Map<V> {
	[key: string]: V;
}

class ID {
	private static base: string = `${Date.now().toString()}-`;
	private static counter: number = 0;
	public static next(): string {
		return `${ID.base}${ID.counter++}`
	}
}

interface Settings {
	eslint: {
		enable: boolean;
		enableAutofixOnSave: boolean;
		options: any;
	}
	[key: string]: any;
}

export interface ESLintAutoFixEdit {
	range: [number, number];
	text: string;
}

export interface ESLintProblem {
	line: number;
	column: number;
	severity: number;
	ruleId: string;
	message: string;
	fix?: ESLintAutoFixEdit;
}

export interface ESLintDocumentReport {
	filePath: string;
	errorCount: number;
	warningCount: number;
	messages: ESLintProblem[];
	output?: string;
}

export interface ESLintReport {
	errorCount: number;
	warningCount: number;
	results: ESLintDocumentReport[];
}

function makeDiagnostic(problem: ESLintProblem): Diagnostic {
	let message = (problem.ruleId != null)
		? `${problem.message} (${problem.ruleId})`
		: `${problem.message}`;
	return {
		message: message,
		severity: convertSeverity(problem.severity),
		source: 'eslint',
		range: {
			start: { line: problem.line - 1, character: problem.column - 1 },
			end: { line: problem.line - 1, character: problem.column - 1 }
		},
		code: problem.ruleId
	};
}

interface AutoFix {
	label: string;
	documentVersion: number;
	ruleId: string;
	edit: ESLintAutoFixEdit;
}

function computeKey(diagnostic: Diagnostic): string {
	let range = diagnostic.range;
	return `[${range.start.line},${range.start.character},${range.end.line},${range.end.character}]-${diagnostic.code}`;
}

let codeActions: Map<Map<AutoFix>> = Object.create(null);
function recordCodeAction(document: TextDocument, diagnostic: Diagnostic, problem: ESLintProblem): void {
	if (!problem.fix || !problem.ruleId) {
		return;
	}
	let uri = document.uri;
	let edits: Map<AutoFix> = codeActions[uri];
	if (!edits) {
		edits = Object.create(null);
		codeActions[uri] = edits;
	}
	edits[computeKey(diagnostic)] = { label: `Fix this ${problem.ruleId} problem`, documentVersion: document.version, ruleId: problem.ruleId, edit: problem.fix};
}

function convertSeverity(severity: number): number {
	switch (severity) {
		// Eslint 1 is warning
		case 1:
			return DiagnosticSeverity.Warning;
		case 2:
			return DiagnosticSeverity.Error;
		default:
			return DiagnosticSeverity.Error;
	}
}

let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let lib: any = null;
let settings: Settings = null;
let options: any = null;
let documents: TextDocuments = new TextDocuments();

// The documents manager listen for text document create, change
// and close on the connection
documents.listen(connection);
// A text document has changed. Validate the document.
documents.onDidChangeContent((event) => {
	validateSingle(event.document);
});

connection.onInitialize((params): Thenable<InitializeResult | ResponseError<InitializeError>> => {
	let rootPath = params.rootPath;

	function resolveModuleSuccess(value: any): InitializeResult | ResponseError<InitializeError> {
		if (!value.CLIEngine) {
			return new ResponseError(99, 'The eslint library doesn\'t export a CLIEngine. You need at least eslint@1.0.0', { retry: false });
		}
		lib = value;
		let result: InitializeResult = { capabilities: { textDocumentSync: documents.syncKind, codeActionProvider: true }};
		return result;
	};

	return Files.resolveModule(rootPath, 'eslint').then(
		resolveModuleSuccess,
		(error) => {
			if (!rootPath) {
				return new ResponseError<InitializeError>(
					99,
					'Failed to load eslint library. Please install eslint globally using \'npm install -g eslint\' and then press Retry.',
					{ retry: true }
				);
			} else {
				return connection.window.showWarningMessage(
					'Failed to load the ESLint library. Do you want to install ESLint locally into your workspace folder? This may take a minute or two.',
					{ title: 'Install locally', id: 'local' }
				).then((selection) => {
					if (selection && selection.id === 'local') {
						let cmd: string = 'npm install eslint';
						if (fs.existsSync(path.join(rootPath, 'package.json'))) {
							cmd = cmd + ' --save-dev';
						};
						let responseError = new ResponseError<InitializeError>(
							99,
							`Failed to install ESLint running ${cmd}. Please install ESLint manually.`,
							{ retry: false }
						);
						return new Promise((resolve, reject) => {
							exec(cmd, (error: Error, stdout: Buffer, stderr: Buffer) => {
								if (error) {
									reject(responseError);
								}
								resolve();
							});
						}).then(() => {
							return Files.resolveModule(rootPath, 'eslint').then(resolveModuleSuccess, (error) => {
								return responseError;
							});
						});
					} else {
						return new ResponseError<InitializeError>(
							99,
							null,
							{ retry: false }
						);
					}
				});
			}
	});
});

function getMessage(err: any, document: TextDocument): string {
	let result: string = null;
	if (typeof err.message === 'string' || err.message instanceof String) {
		result = <string>err.message;
		result = result.replace(/\r?\n/g, ' ');
		if (/^CLI: /.test(result)) {
			result = result.substr(5);
		}
	} else {
		result = `An unknown error occured while validating file: ${Files.uriToFilePath(document.uri)}`;
	}
	return result;
}

function validate(document: TextDocument): void {
	let CLIEngine = lib.CLIEngine;
	var cli = new CLIEngine(options);
	let content = document.getText();
	let uri = document.uri;
	// Clean previously computed code actions.
	delete codeActions[uri];
	let report: ESLintReport = cli.executeOnText(content, Files.uriToFilePath(uri));
	let diagnostics: Diagnostic[] = [];
	if (report && report.results && Array.isArray(report.results) && report.results.length > 0) {
		let docReport = report.results[0];
		if (docReport.messages && Array.isArray(docReport.messages)) {
			docReport.messages.forEach((problem) => {
				if (problem) {
					let diagnostic = makeDiagnostic(problem);
					diagnostics.push(diagnostic);
					recordCodeAction(document, diagnostic, problem);
				}
			});
		}
	}
	// Publish the diagnostics
	return connection.sendDiagnostics({ uri, diagnostics });
}

function validateSingle(document: TextDocument): void {
	try {
		validate(document);
	} catch (err) {
		connection.window.showErrorMessage(getMessage(err, document));
	}
}

function validateMany(documents: TextDocument[]): void {
	let tracker = new ErrorMessageTracker();
	documents.forEach(document => {
		try {
			validate(document);
		} catch (err) {
			tracker.add(getMessage(err, document));
		}
	});
	tracker.sendErrors(connection);
}

connection.onDidChangeConfiguration((params) => {
	settings = params.settings;
	if (settings.eslint) {
		options = settings.eslint.options || {};
	}
	// Settings have changed. Revalidate all documents.
	validateMany(documents.all());
});

connection.onDidChangeWatchedFiles((params) => {
	// A .eslintrc has change. No smartness here.
	// Simply revalidate all file.
	validateMany(documents.all());
});

connection.onCodeAction((params) => {
	let result: Command[] = [];
	let uri = params.textDocument.uri;
	let textDocument = documents.get(uri);
	let edits = codeActions[uri];
	let documentVersion: number = -1;
	let ruleId: string;
	function createTextEdit(editInfo: AutoFix): TextEdit {
		return TextEdit.replace(Range.create(textDocument.positionAt(editInfo.edit.range[0]), textDocument.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
	}
	if (edits) {
		for(let diagnostic of params.context.diagnostics) {
			let key = computeKey(diagnostic);
			let editInfo = edits[key];
			if (editInfo) {
				documentVersion = editInfo.documentVersion;
				ruleId = editInfo.ruleId;
				result.push(Command.create(editInfo.label, 'eslint.applySingleFix', uri, documentVersion, [
					createTextEdit(editInfo)
				]));

			}
		}
		if (result.length > 0) {
			let same: AutoFix[] = [];
			let all: AutoFix[] = [];
			let fixes: AutoFix[] = Object.keys(edits).map(key => edits[key]);
			fixes = fixes.sort((a, b) => {
				let d = a.edit.range[0] - b.edit.range[0];
				if (d !== 0) {
					return d;
				}
				if (a.edit.range[1] === 0) {
					return -1;
				}
				if (b.edit.range[1] === 0) {
					return 1;
				}
				return a.edit.range[1] - b.edit.range[1];
			});
			function overlaps(lastEdit: AutoFix, newEdit: AutoFix): boolean {
				return !!lastEdit && lastEdit.edit.range[1] > newEdit.edit.range[0];
			}
			function getLastEdit(array: AutoFix[]): AutoFix {
				let length = array.length;
				if (length === 0) {
					return undefined;
				}
				return array[length - 1];
			}
			for (let editInfo of fixes) {
				if (documentVersion === -1) {
					documentVersion = editInfo.documentVersion;
				}
				if (editInfo.ruleId === ruleId && !overlaps(getLastEdit(same), editInfo)) {
					same.push(editInfo);
				}
				if (!overlaps(getLastEdit(all), editInfo)) {
					all.push(editInfo);
				}
			}
			if (same.length > 1) {
				result.push(Command.create(`Fix all ${ruleId} problems`, 'eslint.applySameFixes', uri, documentVersion, same.map(createTextEdit)));
			}
			if (all.length > 1) {
				result.push(Command.create(`Fix all auto-fixable problems`, 'eslint.applyAllFixes', uri, documentVersion, all.map(createTextEdit)));
			}
		}
	}
	return result;
});

connection.listen();