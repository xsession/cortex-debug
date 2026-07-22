import * as vscode from 'vscode';
import { parseHexOrDecInt } from '../common';
import { CortexDebugExtension } from './extension';
import { hexFormat } from './utils';

// We have to maintain our own list of what is changed because vscode.TextDocument.isClosed does not work as expected
// We don't  understand the lifecycle of a textDoc because it lingers in the system even after it is closed
interface MemDocStatus {
    textDoc: vscode.TextDocument;       // For debug
    isClosed: boolean;
    uri: vscode.Uri;
    lastText: string;
}

export class MemoryContentProvider implements vscode.TextDocumentContentProvider {
    // tslint:disable-next-line:variable-name
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;
    private allMemoryWindows: { [path: string]: MemDocStatus } = {};

    public Unregister(doc: vscode.TextDocument) {
        const p = this.allMemoryWindows[doc.uri.path];
        if (p) {
            p.isClosed = true;
            p.textDoc = undefined;
        }
    }

    public PreRegister(uri: vscode.Uri) {
        const docStatus: MemDocStatus = {
            textDoc: undefined,     // Right now, we don't know what this is.
            isClosed: false,
            uri: uri,
            lastText: ''
        };
        this.allMemoryWindows[uri.path] = docStatus;
    }

    public Register(doc: vscode.TextDocument) {
        const docStatus: MemDocStatus = this.allMemoryWindows[doc.uri.path];
        if (docStatus) {
            docStatus.textDoc = doc;
            docStatus.isClosed = false;
        }
    }

    public provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
        return new Promise((resolve, reject) => {
            const docStatus: MemDocStatus = this.allMemoryWindows[uri.path];
            if (docStatus && docStatus.isClosed) {
                resolve(docStatus.lastText);
                return;
            }

            const highlightAt = -1;
            const query = this.parseQuery(uri.query);

            const addressExpr = query['address'];
            const length: number = parseHexOrDecInt(query['length']);

            const session = CortexDebugExtension.getActiveCDSession();
            if (session) {
                session.customRequest('get-arguments').then((args) => {
                    const addressUnitBytes = args?.memoryAddressUnitBytes === 2 ? 2 : 1;
                    const lengthUnits = length || 32;
                    return session.customRequest('read-memory', {
                        address: addressExpr,
                        length: lengthUnits * addressUnitBytes
                    }).then((data) => ({ data, addressUnitBytes, lengthUnits }));
                }).then(({ data, addressUnitBytes, lengthUnits }) => {
                    const bytes = data.bytes;
                    const byteAddress = parseHexOrDecInt(data.startAddress);
                    const address = Math.floor(byteAddress / addressUnitBytes);
                    let lineAddress = address - (address % 16);
                    const offset = address - lineAddress;
                    const cellWidth = addressUnitBytes * 2;
                    const bytesToCell = (unitIndex: number) => {
                        let text = '';
                        const byteOffset = unitIndex * addressUnitBytes;
                        for (let byteIndex = 0; byteIndex < addressUnitBytes; byteIndex++) {
                            const value = bytes[byteOffset + byteIndex] ?? 0;
                            text = hexFormat(value, 2, false).toUpperCase() + text;
                        }
                        return text;
                    };

                    let output = '';
                    output += addressUnitBytes === 1
                        ? '  Offset: 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F \t\n'
                        : '  Offset: 0000 0001 0002 0003 0004 0005 0006 0007 0008 0009 000A 000B 000C 000D 000E 000F \t\n';
                    output += hexFormat(lineAddress, 8, false) + ': ';

                    let lineend = '';

                    for (let i = 0; i < offset; i++) {
                        output += ' '.repeat(cellWidth + 1);
                        lineend += ' ';
                    }

                    for (let i = 0; i < lengthUnits; i++) {
                        const byte = bytes[i * addressUnitBytes];
                        output += bytesToCell(i) + ' ';
                        if (addressUnitBytes !== 1 || byte <= 32 || (byte >= 127 && byte <= 159)) {
                            lineend += '.';
                        } else {
                            lineend += String.fromCharCode(byte);
                        }

                        if ((address + i) % 16 === 15 && i < lengthUnits - 1) {
                            output += '  ' + lineend;
                            lineend = '';
                            output += '\n';
                            lineAddress += 16;
                            output += hexFormat(lineAddress, 8, false) + ': ';
                        }
                    }

                    const endaddress = address + lengthUnits;
                    const extra = (16 - (endaddress % 16)) % 16;

                    for (let i = 0; i < extra; i++) {
                        output += ' '.repeat(cellWidth + 1);
                    }
                    output += '  ' + lineend;
                    output += '\n';

                    if (docStatus) {
                        docStatus.lastText = output;
                    }
                    resolve(output);
                }, (error) => {
                    const msg = error.message || '';
                    vscode.window.showErrorMessage(`Unable to read memory from ${addressExpr} of length ${hexFormat(length, 8)}: ${msg}`);
                    reject(error.toString());
                });
            } else {
                reject(new Error('MemoryContentProvider: unknown debug session type'));
            }
        });
    }

    public update(doc: vscode.TextDocument) {
        this._onDidChange.fire(doc.uri);
    }

    private parseQuery(queryString) {
        const query = {};
        function addToQuery(str: string) {
            const pair = str.split('=');
            const name = pair.shift();      // First part is name
            query[name] = pair.join('=');   // Rest is the value
        }
        // The API has already decoded the URI.
        const pairs = (queryString[0] === '?' ? queryString.substr(1) : queryString).split('&');
        for (const pair of pairs)
            addToQuery(pair);
        return query;
    }

    /**
     * The code below took significant portions with small modification
     * from the HexDump extension, which has the following license and copyright:
     * The MIT License (MIT)
     * **Copyright © 2016 Stef Levesque**
     */
    public firstBytePos = 10;
    public lastBytePos: number = this.firstBytePos + 3 * 16 - 1;
    public firstAsciiPos: number = this.lastBytePos + 3;
    public lastAsciiPos: number = this.firstAsciiPos + 16;

    private getAddressUnitBytes(uri: vscode.Uri): number {
        const query = this.parseQuery(uri.query);
        const unit = parseHexOrDecInt(query['addressUnitBytes'] || '1');
        return unit === 2 ? 2 : 1;
    }

    private getOffset(uri: vscode.Uri, pos: vscode.Position): number {
        // check if within a valid section
        if (pos.line < 1 || pos.character < this.firstBytePos) {
            return;
        }

        let offset = (pos.line - 1) * 16;
        const s = pos.character - this.firstBytePos;
        const addressUnitBytes = this.getAddressUnitBytes(uri);
        const cellWidth = addressUnitBytes * 2;
        const cellStride = cellWidth + 1;
        const lastCellPos = this.firstBytePos + cellStride * 16 - 2;
        const firstAsciiPos = lastCellPos + 3;
        if (pos.character >= this.firstBytePos && pos.character <= lastCellPos) {
            offset += Math.floor(s / cellStride);
        } else if (pos.character >= firstAsciiPos) {
            offset += (pos.character - firstAsciiPos);
        }
        return offset;
    }

    private getPosition(offset: number, ascii: boolean = false, addressUnitBytes: number = 1): vscode.Position {
        const row = 1 + Math.floor(offset / 16);
        let column = offset % 16;

        if (ascii) {
            const lastCellPos = this.firstBytePos + (addressUnitBytes * 2 + 1) * 16 - 2;
            column += lastCellPos + 3;
        } else {
            column = this.firstBytePos + column * (addressUnitBytes * 2 + 1);
        }

        return new vscode.Position(row, column);
    }

    private getRanges(startOffset: number, endOffset: number, ascii: boolean, addressUnitBytes: number): vscode.Range[] {
        const startPos = this.getPosition(startOffset, ascii, addressUnitBytes);
        let endPos = this.getPosition(endOffset, ascii, addressUnitBytes);
        endPos = new vscode.Position(endPos.line, endPos.character + (ascii ? 1 : addressUnitBytes * 2));

        const ranges: vscode.Range[] = [];
        const lastCellPos = this.firstBytePos + (addressUnitBytes * 2 + 1) * 16 - 2;
        const firstAsciiPos = lastCellPos + 3;
        const firstOffset = ascii ? firstAsciiPos : this.firstBytePos;
        const lastOffset = ascii ? firstAsciiPos + 16 : lastCellPos;
        for (let i = startPos.line; i <= endPos.line; ++i) {
            const start = new vscode.Position(i, (i === startPos.line ? startPos.character : firstOffset));
            const end = new vscode.Position(i, (i === endPos.line ? endPos.character : lastOffset));
            ranges.push(new vscode.Range(start, end));
        }

        return ranges;
    }

    private smallDecorationType = vscode.window.createTextEditorDecorationType({
        borderWidth: '1px',
        borderStyle: 'solid',
        overviewRulerColor: 'blue',
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        light: { // this color will be used in light color themes
            borderColor: 'darkblue'
        },
        dark: { // this color will be used in dark color themes
            borderColor: 'lightblue'
        }
    });

    public handleSelection(e: vscode.TextEditorSelectionChangeEvent) {
        const numLine = e.textEditor.document.lineCount;
        if (e.selections[0].start.line + 1 === numLine
            || e.selections[0].end.line + 1 === numLine) {
            e.textEditor.setDecorations(this.smallDecorationType, []);
            return;
        }
        const startOffset = this.getOffset(e.textEditor.document.uri, e.selections[0].start);
        const endOffset = this.getOffset(e.textEditor.document.uri, e.selections[0].end);
        const addressUnitBytes = this.getAddressUnitBytes(e.textEditor.document.uri);
        if (typeof startOffset === 'undefined'
            || typeof endOffset === 'undefined') {
            e.textEditor.setDecorations(this.smallDecorationType, []);
            return;
        }

        let ranges = this.getRanges(startOffset, endOffset, false, addressUnitBytes);
        ranges = ranges.concat(this.getRanges(startOffset, endOffset, true, addressUnitBytes));
        e.textEditor.setDecorations(this.smallDecorationType, ranges);
    }
}
