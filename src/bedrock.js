import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { normalizeCommand } from './commands.js';

function commandError(message, code, resultUnknown = false) {
  return Object.assign(new Error(message), { code, resultUnknown });
}

/** Local, unencrypted WebSocket transport for the Bedrock /connect command. */
export class BedrockBridge {
  constructor({ host = '127.0.0.1', port = 19131, commandTimeoutMs = 10_000 } = {}) {
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
      throw new Error('The Bedrock bridge must bind to a loopback host.');
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('Port must be an integer between 0 and 65535.');
    }
    if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
      throw new Error('commandTimeoutMs must be positive.');
    }
    this.host = host;
    this.port = port;
    this.commandTimeoutMs = commandTimeoutMs;
    this._server = null;
    this._socket = null;
    this._connectedAt = null;
    this._lastError = null;
    this._queue = [];
    this._pending = null;
    this._starting = null;
    this._closing = null;
  }

  async start() {
    if (this._closing) await this._closing;
    if (this._starting) return this._starting;
    if (this._server?.address()) return this._server.address();

    const server = new WebSocketServer({
      host: this.host,
      port: this.port,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    });
    this._server = server;
    server.on('connection', (socket) => this._accept(socket));
    // Retain an error listener after startup, so network errors never crash stdio MCP.
    server.on('error', (error) => { this._lastError = error.message; });

    this._starting = new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        if (this._server === server) this._server = null;
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
    });
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  status() {
    const address = this._server?.address();
    const port = address && typeof address === 'object' ? address.port : this.port;
    const endpointHost = this.host.includes(':') ? `[${this.host}]` : this.host;
    return {
      listening: Boolean(address),
      connected: this._socket?.readyState === WebSocket.OPEN,
      host: this.host,
      port,
      connectCommand: `/connect ${endpointHost}:${port}`,
      connectedAt: this._connectedAt,
      queuedCommands: this._queue.length,
      inFlight: this._pending ? {
        requestId: this._pending.requestId,
        command: this._pending.command,
      } : null,
      lastError: this._lastError,
      requireEncryptedWebsockets: false,
      encryptionNote: 'Set Minecraft Settings > General > Require Encrypted Websockets to OFF. This bridge uses local, unencrypted WebSockets.',
    };
  }

  async command(command) {
    const commandLine = normalizeCommand(command);
    if (this._socket?.readyState !== WebSocket.OPEN || this._closing) {
      throw commandError(`Minecraft is not connected. In the game, run ${this.status().connectCommand}`, 'NOT_CONNECTED');
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ command: commandLine, resolve, reject });
      this._drain();
    });
  }

  _accept(socket) {
    // Even rejected connections need an error listener.
    socket.on('error', (error) => {
      if (this._socket !== socket) return;
      this._lastError = error.message;
      this._disconnect(socket, 'The Minecraft connection failed.');
      socket.terminate();
    });
    if (this._closing || this._socket) {
      socket.close(1008, 'A Minecraft client is already connected.');
      return;
    }
    this._socket = socket;
    this._connectedAt = new Date().toISOString();
    this._lastError = null;
    socket.on('message', (data) => this._receive(socket, data));
    socket.on('close', () => this._disconnect(socket, 'The Minecraft connection closed.'));
  }

  _receive(socket, data) {
    if (this._socket !== socket) return;
    let packet;
    try {
      packet = JSON.parse(data.toString());
    } catch {
      this._lastError = 'Ignored an invalid JSON message from Minecraft.';
      return;
    }
    const pending = this._pending;
    if (!pending || packet?.header?.requestId !== pending.requestId) return;
    const purpose = packet.header.messagePurpose;
    if (purpose !== 'commandResponse' && purpose !== 'error') return;
    if (!packet.body || typeof packet.body !== 'object' || Array.isArray(packet.body)
      || !Number.isSafeInteger(packet.body.statusCode)) {
      this._lastError = 'Minecraft returned an invalid command response without a numeric statusCode.';
      this._disconnect(socket, this._lastError, 'INVALID_RESPONSE');
      socket.terminate();
      return;
    }

    clearTimeout(pending.timer);
    this._pending = null;
    pending.resolve({
      requestId: pending.requestId,
      command: pending.command,
      messagePurpose: purpose,
      statusCode: packet.body.statusCode,
      body: packet.body,
    });
    this._drain();
  }

  _drain() {
    if (this._pending || !this._queue.length || this._socket?.readyState !== WebSocket.OPEN) return;
    const socket = this._socket;
    const pending = this._queue.shift();
    pending.requestId = randomUUID();
    this._pending = pending;
    pending.timer = setTimeout(() => {
      if (this._pending !== pending) return;
      this._lastError = `Timed out after ${this.commandTimeoutMs} ms waiting for Minecraft.`;
      // The game may still execute this request. End the session to avoid sending
      // later commands after an unknown result, and never replay queued commands.
      this._disconnect(socket, this._lastError, 'COMMAND_TIMEOUT');
      socket.terminate();
    }, this.commandTimeoutMs);

    const packet = {
      header: {
        version: 1,
        requestId: pending.requestId,
        messageType: 'commandRequest',
        messagePurpose: 'commandRequest',
      },
      body: {
        commandLine: pending.command,
        origin: { type: 'player' },
      },
    };
    // body.version selects Minecraft command syntax, not the transport protocol.
    // Omit it so the game uses its current syntax (bedrock-ws Client.run).
    try {
      socket.send(JSON.stringify(packet), (error) => {
        if (!error || this._socket !== socket) return;
        this._lastError = error.message;
        this._disconnect(socket, 'Sending the Minecraft command failed.');
        socket.terminate();
      });
    } catch (error) {
      this._lastError = error.message;
      this._disconnect(socket, 'Sending the Minecraft command failed.');
      socket.terminate();
    }
  }

  _disconnect(socket, reason, code = 'CONNECTION_CLOSED') {
    if (this._socket !== socket) return;
    this._socket = null;
    this._connectedAt = null;
    this._rejectCommands(reason, code);
  }

  _rejectCommands(reason, code) {
    const pending = this._pending;
    this._pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(commandError(`${reason} The command result is unknown; it may have executed. Do not retry automatically.`, code, true));
    }
    for (const queued of this._queue.splice(0)) {
      queued.reject(commandError(`${reason} This queued command was not sent.`, code));
    }
  }

  async close() {
    if (this._closing) return this._closing;
    this._rejectCommands('The Bedrock bridge is closing.', 'BRIDGE_CLOSED');
    this._socket = null;
    this._connectedAt = null;
    const server = this._server;
    this._server = null;
    if (!server) return;
    this._closing = new Promise((resolve) => {
      for (const socket of server.clients) socket.terminate();
      server.close(() => resolve());
    });
    try {
      await this._closing;
    } finally {
      this._closing = null;
    }
  }
}
