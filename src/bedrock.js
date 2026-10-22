import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import WebSocket, { WebSocketServer } from 'ws';
import { normalizeCommand } from './commands.js';
import { createEncryptionOffer } from './encryption.js';

const ENCRYPTION_PROTOCOL = 'com.microsoft.minecraft.wsencrypt';
const visibleCommand = command => command.startsWith('enableencryption ') ? 'enableencryption [key exchange]' : command;

function commandError(message, code, resultUnknown = false) {
  return Object.assign(new Error(message), { code, resultUnknown });
}

function sessionDiagnostics() {
  return {
    receivedFrames: 0,
    invalidJsonFrames: 0,
    binaryFrames: 0,
    sentCommands: 0,
    lastReceivedAt: null,
    recentFrames: [],
  };
}

function shortString(value, limit = 100) {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

/** Local WebSocket transport, with Bedrock's optional encrypted subprotocol. */
export class BedrockBridge {
  constructor({ host = '127.0.0.1', port = 19131, commandTimeoutMs = 10_000, maxQueuedCommands = 1024 } = {}) {
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
      throw new Error('The Bedrock bridge must bind to a loopback host.');
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('Port must be an integer between 0 and 65535.');
    }
    if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
      throw new Error('commandTimeoutMs must be positive.');
    }
    if (!Number.isInteger(maxQueuedCommands) || maxQueuedCommands < 1) {
      throw new Error('maxQueuedCommands must be a positive integer.');
    }
    this.host = host;
    this.port = port;
    this.commandTimeoutMs = commandTimeoutMs;
    this.maxQueuedCommands = maxQueuedCommands;
    this._server = null;
    this._socket = null;
    this._connectedAt = null;
    this._lastError = null;
    this._lastDisconnect = null;
    this._diagnostics = sessionDiagnostics();
    this._queue = [];
    this._pending = new Map();
    this._activeJob = null;
    this._starting = null;
    this._closing = null;
    this._cipher = null;
    this._encryptedInbound = false;
    this._ready = false;
    this._initialization = 'disconnected';
  }

  async start() {
    if (this._closing) await this._closing;
    if (this._starting) return this._starting;
    if (this._server?.address()) return this._server.address();

    this._starting = (async () => {
      try { return await this._listen(this.port); }
      catch (error) {
        // Codex can start independent MCP clients for concurrent sessions.
        // Keep this session usable without displacing another connected world.
        if (error.code === 'EADDRINUSE' && this.port !== 0) return this._listen(0);
        throw error;
      }
    })();
    try { return await this._starting; }
    finally { this._starting = null; }
  }

  _listen(port) {
    const server = new WebSocketServer({
      host: this.host,
      port,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
      // Accept historical encrypted text frames as well as modern binary frames.
      skipUTF8Validation: true,
      handleProtocols: protocols => protocols.has(ENCRYPTION_PROTOCOL) ? ENCRYPTION_PROTOCOL : false,
    });
    this._server = server;
    server.on('connection', (socket) => this._accept(socket));
    // Retain an error listener after startup, so network errors never crash stdio MCP.
    server.on('error', (error) => { this._lastError = error.message; });

    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        if (this._server === server) this._server = null;
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        this._lastError = null;
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
    });
  }

  status() {
    const address = this._server?.address();
    const port = address && typeof address === 'object' ? address.port : this.port;
    const endpointHost = this.host.includes(':') ? `[${this.host}]` : this.host;
    const outstanding = [...this._pending.values()];
    const active = outstanding.filter(entry => !entry.awaitingLateResponse);
    const late = outstanding.filter(entry => entry.awaitingLateResponse);
    const pending = active[0];
    const awaiting = late[0];
    return {
      listening: Boolean(address),
      connected: this._socket?.readyState === WebSocket.OPEN,
      ready: this._ready,
      encryption: this._cipher ? 'enabled' : 'disabled',
      initialization: this._initialization,
      websocketProtocol: this._socket?.protocol ?? null,
      host: this.host,
      port,
      connectCommand: `/connect ${endpointHost}:${port}`,
      connectedAt: this._connectedAt,
      queuedCommands: this._queue.length,
      maxQueuedCommands: this.maxQueuedCommands,
      inFlightCount: active.length,
      outstandingCommands: outstanding.length,
      awaitingLateResponseCount: late.length,
      batchConcurrency: this._activeJob?.concurrency ?? 1,
      inFlight: pending ? {
        requestId: pending.requestId,
        command: visibleCommand(pending.command),
      } : null,
      awaitingLateResponse: awaiting ? {
        requestId: awaiting.requestId,
        command: visibleCommand(awaiting.command),
        timedOutAt: awaiting.timedOutAt ?? null,
      } : null,
      lastError: this._lastError,
      lastDisconnect: this._lastDisconnect ? { ...this._lastDisconnect } : null,
      diagnostics: {
        ...this._diagnostics,
        recentFrames: this._diagnostics.recentFrames.map((frame) => ({ ...frame })),
      },
      supportsEncryptedWebsockets: true,
      encryptionNote: 'Bedrock encryption is negotiated when the client requests com.microsoft.minecraft.wsencrypt. Listener is loopback only.',
    };
  }

  async command(command) {
    const commandLine = normalizeCommand(command);
    this._assertReady();
    return this._enqueue(commandLine);
  }

  async batch(commands, { concurrency = 1, stopOnError = true } = {}) {
    if (!Array.isArray(commands) || commands.length < 1 || commands.length > 128) {
      throw new RangeError('A batch must contain between 1 and 128 commands.');
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new RangeError('concurrency must be an integer between 1 and 16.');
    }
    if (typeof stopOnError !== 'boolean') throw new TypeError('stopOnError must be a boolean.');
    if (concurrency > 1 && stopOnError) {
      throw new Error('Pipelined batches require stopOnError=false: commands already sent cannot be stopped. Use only independent commands.');
    }
    // Normalize every entry and reserve queue space before any world change.
    const normalized = commands.map(normalizeCommand);
    this._assertReady();
    return this._enqueueJob(normalized, { concurrency, stopOnError, batch: true });
  }

  _assertReady() {
    if (this._socket?.readyState !== WebSocket.OPEN || this._closing) {
      throw commandError(`Minecraft is not connected. In the game, run ${this.status().connectCommand}`, 'NOT_CONNECTED');
    }
    if (this._quarantined()) {
      throw commandError('The previous command result is still unknown. Waiting for its matching response; this command was not sent. Do not retry the previous command automatically.', 'COMMAND_RESULT_PENDING');
    }
    if (!this._ready) {
      throw commandError(`Minecraft session initialization is ${this._initialization}. This command was not sent. Check minecraft_status.`, 'SESSION_NOT_READY');
    }
  }

  _enqueue(commandLine, onResponse, frame) {
    return this._enqueueJob([commandLine], { onResponse, frame });
  }

  _enqueueJob(commands, { concurrency = 1, stopOnError = true, batch = false, onResponse, frame } = {}) {
    if (this._queue.length + commands.length > this.maxQueuedCommands) {
      return Promise.reject(commandError('The command queue is full. This work was not sent.', 'QUEUE_FULL'));
    }
    return new Promise((resolve, reject) => {
      const job = { concurrency, stopOnError, batch, resolve, reject, requested: commands.length,
        remaining: commands.length, sent: 0, completed: 0, results: [], failures: [] };
      commands.forEach((command, index) => this._queue.push({ command, index, job, onResponse, frame }));
      this._drain();
    });
  }

  _quarantined() {
    return [...this._pending.values()].some(entry => entry.awaitingLateResponse);
  }

  _settle(entry, result, error) {
    if (entry.settled) return;
    entry.settled = true;
    const job = entry.job;
    job.remaining -= 1;
    if (result) {
      job.results[entry.index] = job.batch ? { index: entry.index, ...result } : result;
      job.completed += 1;
    } else if (error) {
      job.failures.push({ index: entry.index, command: entry.command,
        error: error.message, code: error.code, resultUnknown: Boolean(error.resultUnknown) });
    }
    if (job.remaining) return;
    if (this._activeJob === job) this._activeJob = null;
    if (!job.batch) {
      if (error) job.reject(error);
      else job.resolve(result);
      return;
    }
    const failures = job.failures.sort((left, right) => left.index - right.index);
    const failure = failures.find(item => item.resultUnknown) ?? failures[0];
    job.resolve({
      results: job.results.filter(Boolean), requested: job.requested, completed: job.completed,
      sent: job.sent, skipped: job.requested - job.sent,
      ...(failure ? { error: failure.error, code: failure.code, interruptedCommand: failure.command,
        resultUnknown: failures.some(item => item.resultUnknown), failures } : {}),
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
    this._lastDisconnect = null;
    this._diagnostics = sessionDiagnostics();
    this._cipher = null;
    this._encryptedInbound = false;
    this._ready = socket.protocol !== ENCRYPTION_PROTOCOL;
    this._initialization = this._ready ? 'ready' : 'getting_player_name';
    socket.on('message', (data, isBinary) => this._receive(socket, data, isBinary));
    socket.on('close', (code, reason) => {
      if (this._socket !== socket) return;
      this._lastDisconnect = {
        at: new Date().toISOString(),
        code,
        reason: reason.toString().slice(0, 300),
      };
      this._disconnect(socket, 'The Minecraft connection closed.');
    });
    if (!this._ready) void this._initializeEncryption(socket);
  }

  _initializeEncryption(socket) {
    const fail = error => {
      if (this._socket !== socket) return;
      this._initialization = 'failed';
      this._ready = false;
      this._lastError = `Session initialization failed: ${error.message}`;
    };
    // Response callbacks also run for late replies, so a paused game can resume
    // this sequence after the original promise has already timed out.
    void this._enqueue('getlocalplayername', name => {
      if (this._socket !== socket) return;
      if (name.messagePurpose === 'error' || name.statusCode < 0) {
        fail(new Error('Minecraft rejected getlocalplayername during initialization.'));
        return;
      }
      const offer = createEncryptionOffer();
      this._initialization = 'negotiating_encryption';
      void this._enqueue('ws:encrypt [key exchange]', result => {
        if (result.messagePurpose === 'error' || result.statusCode < 0) throw new Error('Minecraft rejected the encryption handshake.');
        // Install synchronously after ws:encrypt. This response intentionally
        // lacks statusCode; only ordinary command replies require it.
        this._cipher = offer.complete(result.body.publicKey);
        this._ready = true;
        this._initialization = 'ready';
      }, { purpose: 'ws:encrypt', body: offer.requestBody }).catch(fail);
    }).catch(fail);
  }

  _receive(socket, data, isBinary = false) {
    if (this._socket !== socket) return;
    const payload = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    const receivedAt = new Date().toISOString();
    const diagnostics = this._diagnostics;
    diagnostics.receivedFrames += 1;
    diagnostics.lastReceivedAt = receivedAt;
    if (isBinary) diagnostics.binaryFrames += 1;
    const summary = { receivedAt, binary: Boolean(isBinary), bytes: payload.byteLength };
    diagnostics.recentFrames.push(summary);
    if (diagnostics.recentFrames.length > 8) diagnostics.recentFrames.shift();
    let packet;
    try {
      // A plaintext reply can trail the key-exchange notification. Do not
      // consume the continuous decipher until the first actual ciphertext.
      // See mcpews base.ts. Parse full JSON rather than guessing from one byte.
      if (this._cipher && !this._encryptedInbound) {
        try { packet = JSON.parse(payload.toString()); } catch { /* ciphertext */ }
      }
      if (!packet) {
        const plaintext = this._cipher ? this._cipher.decrypt(payload) : payload;
        if (this._cipher) this._encryptedInbound = true;
        packet = JSON.parse(plaintext.toString());
      }
    } catch {
      diagnostics.invalidJsonFrames += 1;
      summary.invalidJson = true;
      this._lastError = 'Ignored an invalid JSON message from Minecraft.';
      return;
    }
    // Only allow selected metadata into diagnostics. Never retain command or chat
    // payloads; initial and uncorrelated errors are still useful for debugging.
    summary.messagePurpose = shortString(packet?.header?.messagePurpose);
    summary.requestId = shortString(packet?.header?.requestId);
    if (Number.isSafeInteger(packet?.body?.statusCode)) summary.statusCode = packet.body.statusCode;
    summary.statusMessage = shortString(packet?.body?.statusMessage, 300);
    summary.eventName = shortString(packet?.header?.eventName ?? packet?.body?.eventName);
    const pending = this._pending.get(packet?.header?.requestId);
    if (!pending) return;
    const purpose = packet.header.messagePurpose;
    const expectedPurpose = pending.frame?.purpose ?? 'commandResponse';
    if (purpose !== expectedPurpose && purpose !== 'error') return;
    const isEncryptionReply = expectedPurpose === 'ws:encrypt' && purpose === 'ws:encrypt';
    if (!packet.body || typeof packet.body !== 'object' || Array.isArray(packet.body)
      || (!isEncryptionReply && !Number.isSafeInteger(packet.body.statusCode))) {
      this._lastError = 'Minecraft returned an invalid command response without a numeric statusCode.';
      this._quarantinePending(this._lastError, 'INVALID_RESPONSE');
      return;
    }

    const result = {
      requestId: pending.requestId,
      command: pending.command,
      messagePurpose: purpose,
      // ws:encrypt is a key-exchange response, not a command result. Its
      // publicKey is validated synchronously by the encryption callback.
      statusCode: isEncryptionReply ? 0 : packet.body.statusCode,
      body: packet.body,
    };
    try {
      pending.onResponse?.(result);
    } catch (error) {
      this._lastError = `Invalid encryption response: ${error.message}`;
      this._quarantinePending(this._lastError, 'INVALID_ENCRYPTION_RESPONSE');
      return;
    }
    clearTimeout(pending.timer);
    this._pending.delete(pending.requestId);
    if (pending.awaitingLateResponse && !this._quarantined()) this._lastError = null;
    this._settle(pending, result);
    if (pending.job.stopOnError && (purpose === 'error' || result.statusCode < 0)) {
      // Ordered batches can stop before sending their next command. Later jobs
      // remain queued and can still run once this batch has settled.
      this._discardJob(pending.job);
    }
    this._drain();
  }

  _drain() {
    if (this._quarantined() || !this._queue.length || this._socket?.readyState !== WebSocket.OPEN) return;
    const job = this._activeJob ?? this._queue[0].job;
    this._activeJob = job;
    while (this._queue[0]?.job === job && this._pending.size < job.concurrency
      && this._socket?.readyState === WebSocket.OPEN && !this._quarantined()) {
      this._send(this._queue.shift());
    }
  }

  _send(pending) {
    const socket = this._socket;
    pending.requestId = randomUUID();
    this._pending.set(pending.requestId, pending);
    pending.job.sent += 1;
    pending.timer = setTimeout(() => {
      if (this._pending.get(pending.requestId) !== pending || pending.awaitingLateResponse) return;
      this._lastError = `Timed out after ${this.commandTimeoutMs} ms waiting for Minecraft.`;
      pending.timedOutAt = new Date().toISOString();
      // A pipeline cannot establish outcomes for other commands still in
      // flight. Freeze the entire window until all matching replies arrive.
      this._quarantinePending(this._lastError, 'COMMAND_TIMEOUT');
    }, this.commandTimeoutMs);

    const packet = {
      header: {
        version: 1,
        requestId: pending.requestId,
        ...(!pending.frame ? { messageType: 'commandRequest' } : {}),
        messagePurpose: pending.frame?.purpose ?? 'commandRequest',
      },
      body: pending.frame?.body ?? {
        commandLine: pending.command,
        origin: { type: 'player' },
      },
    };
    // body.version selects Minecraft command syntax, not the transport protocol.
    // Omit it so the game uses its current syntax (bedrock-ws Client.run).
    try {
      this._diagnostics.sentCommands += 1;
      const plaintext = Buffer.from(JSON.stringify(packet));
      const wire = this._cipher ? this._cipher.encrypt(plaintext) : plaintext;
      socket.send(wire, { binary: Boolean(this._cipher) }, (error) => {
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

  _quarantinePending(reason, code) {
    if (!this._pending.size) return;
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.awaitingLateResponse = true;
      pending.timedOutAt ??= new Date().toISOString();
      this._settle(pending, null, commandError(`${reason} The command result is unknown; it may have executed. Do not retry automatically. The connection remains open while waiting for its response.`, code, true));
    }
    this._rejectQueued(reason, code);
  }

  _discardJob(job) {
    const skipped = this._queue.filter(entry => entry.job === job);
    this._queue = this._queue.filter(entry => entry.job !== job);
    for (const entry of skipped) this._settle(entry);
  }

  _disconnect(socket, reason, code = 'CONNECTION_CLOSED') {
    if (this._socket !== socket) return;
    this._socket = null;
    this._connectedAt = null;
    this._ready = false;
    this._initialization = 'disconnected';
    this._cipher = null;
    this._rejectCommands(reason, code);
  }

  _rejectCommands(reason, code) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      this._settle(pending, null, commandError(`${reason} The command result is unknown; it may have executed. Do not retry automatically.`, code, true));
    }
    this._pending.clear();
    this._rejectQueued(reason, code);
    this._activeJob = null;
  }

  _rejectQueued(reason, code) {
    for (const queued of this._queue.splice(0)) {
      this._settle(queued, null, commandError(`${reason} This queued command was not sent.`, code));
    }
  }

  async close() {
    if (this._closing) return this._closing;
    this._rejectCommands('The Bedrock bridge is closing.', 'BRIDGE_CLOSED');
    this._socket = null;
    this._connectedAt = null;
    this._ready = false;
    this._initialization = 'disconnected';
    this._cipher = null;
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
