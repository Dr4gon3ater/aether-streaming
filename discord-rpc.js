const net = require("net");

class SimpleDiscordRPC {
  constructor(clientId) {
    this.clientId = clientId;
    this.socket = null;
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let pipeId = 0;
      const tryConnect = () => {
        if (pipeId > 9) {
          return reject(new Error("Could not connect to Discord RPC"));
        }
        const pipePath = `\\\\.\\pipe\\discord-ipc-${pipeId}`;
        this.socket = net.createConnection(pipePath);

        this.socket.on("connect", () => {
          this.connected = true;
          // Send handshake
          this.sendFrame(0, { v: 1, client_id: this.clientId });
          resolve();
        });

        this.socket.on("error", (err) => {
          pipeId++;
          tryConnect();
        });

        this.socket.on("close", () => {
          this.connected = false;
        });
      };
      
      tryConnect();
    });
  }

  sendFrame(opcode, payload) {
    if (!this.connected || !this.socket) return;
    const jsonStr = JSON.stringify(payload);
    const byteLength = Buffer.byteLength(jsonStr);
    const buffer = Buffer.alloc(8 + byteLength);
    buffer.writeInt32LE(opcode, 0);
    buffer.writeInt32LE(byteLength, 4);
    buffer.write(jsonStr, 8);
    this.socket.write(buffer);
  }

  setActivity(details, state, endTimestamp = null, largeImageKey = "aether_logo", largeImageText = "Aether Streaming") {
    if (!this.connected) return;
    
    const timestamps = { start: Math.round(Date.now() / 1000) };
    if (endTimestamp) {
      timestamps.end = endTimestamp;
    }
    
    const payload = {
      cmd: "SET_ACTIVITY",
      args: {
        pid: process.pid,
        activity: {
          details: details,
          state: state,
          timestamps: timestamps,
          assets: {
            large_image: largeImageKey,
            large_text: largeImageText
          }
        }
      },
      nonce: Date.now().toString()
    };
    this.sendFrame(1, payload);
  }

  clearActivity() {
    if (!this.connected) return;
    const payload = {
      cmd: "SET_ACTIVITY",
      args: {
        pid: process.pid,
        activity: null
      },
      nonce: Date.now().toString()
    };
    this.sendFrame(1, payload);
  }
}

module.exports = SimpleDiscordRPC;

