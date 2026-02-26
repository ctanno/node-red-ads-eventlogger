/**
 * ads-eventlogger-connection  –  Node-RED config node
 *
 * Manages a single ADS connection to the TwinCAT 3 EventLogger Publisher
 * (ADS port 132 by default).  Uses ads-client with rawClient: true because
 * the EventLogger is not a PLC runtime.
 *
 * Owns a SINGLE ADS subscription to IG=1/IO=0xFFFF.  Multiple subscribe
 * nodes share this subscription via the EventEmitter ("eventData" events).
 *
 * Other nodes (e.g. ads-eventlogger-subscribe) reference this config node
 * and share the underlying ADS client instance.
 */

const ads = require("ads-client");
const EventEmitter = require("events");

const constants = require("./eventlogger-constants");

class ConnectionEventEmitter extends EventEmitter {}

module.exports = function (RED) {
  function AdsEventloggerConnection(config) {
    RED.nodes.createNode(this, config);

    // ---- internal state ---------------------------------------------------
    this.adsClient = null;
    this.connecting = null;
    this.retryTimer = null;
    this.eventEmitter = new ConnectionEventEmitter();
    this.connected = false;
    this.firstConnectedEventSent = false;

    // Shared subscription (owned by this config node)
    this._subscription = null;
    this._subscriberCount = 0;  // how many subscribe nodes want data
    this._subscribing = null;   // dedup promise for concurrent _subscribe() calls

    // ---- properties from editor -------------------------------------------
    this.name = config.name;

    // Build connection settings for ads-client
    this.connectionSettings = {
      targetAmsNetId: config.targetAmsNetId,
      targetAdsPort:
        parseInt(config.targetAdsPort) || constants.ADS_PORT_EVENTLOGGER,
      rawClient: true, // EventLogger is NOT a PLC runtime
      autoReconnect: config.autoReconnect !== false,
      reconnectInterval: parseInt(config.reconnectInterval) || 2000,
      timeoutDelay: parseInt(config.timeoutDelay) || 5000,
    };

    // Optional overrides
    if (config.routerAddress) {
      this.connectionSettings.routerAddress = config.routerAddress;
    }
    if (config.routerTcpPort) {
      this.connectionSettings.routerTcpPort = parseInt(config.routerTcpPort);
    }
    if (config.localAmsNetId) {
      this.connectionSettings.localAmsNetId = config.localAmsNetId;
    }
    if (config.localAdsPort) {
      this.connectionSettings.localAdsPort = parseInt(config.localAdsPort);
    }
    if (config.localAddress) {
      this.connectionSettings.localAddress = config.localAddress;
    }
    if (config.localTcpPort) {
      this.connectionSettings.localTcpPort = parseInt(config.localTcpPort);
    }

    // ---- connection state bookkeeping -------------------------------------

    /**
     * Emit a single "connected" event only when the actual state changes
     * (ads-client may fire multiple times).
     */
    this.onConnectedStateChange = (connected) => {
      if (this.connected !== connected || !this.firstConnectedEventSent) {
        this.eventEmitter.emit("connected", connected);
      }
      this.connected = connected;
      this.firstConnectedEventSent = true;

      // Re-subscribe / invalidate shared subscription on state change
      if (connected) {
        if (this._subscriberCount > 0 && !this._subscription) {
          this._subscribe().catch((err) => {
            this.warn(`Re-subscribe after reconnect failed: ${err.message}`);
          });
        }
      } else {
        // Subscription is invalid after disconnect
        this._subscription = null;
      }
    };

    // ---- connect / disconnect ---------------------------------------------

    /**
     * Internal connect – creates client, registers listeners, connects.
     */
    const _connect = async (silence) => {
      if (!silence) {
        this.log(
          `Connecting to EventLogger at ${this.connectionSettings.targetAmsNetId}:${this.connectionSettings.targetAdsPort}...`
        );
      }

      try {
        // Tear down any previous session
        if (this.adsClient) {
          try {
            await this.adsClient.disconnect();
          } catch (_) {
            /* ignore */
          } finally {
            this.adsClient = null;
          }
        }

        this.adsClient = new ads.Client(this.connectionSettings);

        this.adsClient.on("connect", () =>
          this.onConnectedStateChange(true)
        );
        this.adsClient.on("disconnect", () =>
          this.onConnectedStateChange(false)
        );

        const res = await this.adsClient.connect();

        if (!silence) {
          this.log(
            `Connected to EventLogger at ${this.connectionSettings.targetAmsNetId}:${this.connectionSettings.targetAdsPort}`
          );
        }
        return res;
      } catch (err) {
        // Schedule retry if the node hasn't been deleted
        if (this.adsClient) {
          const retryInterval =
            this.connectionSettings.reconnectInterval || 2000;

          if (!silence) {
            this.log(
              `Connecting to EventLogger at ${this.connectionSettings.targetAmsNetId}:${this.connectionSettings.targetAdsPort} failed, retrying in ${retryInterval} ms...`
            );
          }

          this.onConnectedStateChange(false);
          clearTimeout(this.retryTimer);

          this.retryTimer = setTimeout(async () => {
            try {
              await this.connect(true);
            } catch (_) {
              /* will retry again */
            }
          }, retryInterval);
        }
        throw err;
      }
    };

    /**
     * Public connect – deduplicates concurrent callers.
     */
    this.connect = async (silence) => {
      clearTimeout(this.retryTimer);

      let firstCall = false;
      if (!this.connecting) {
        this.connecting = _connect(silence);
        firstCall = true;
      }

      try {
        return await this.connecting;
      } finally {
        if (firstCall) this.connecting = null;
      }
    };

    // ---- public helpers ---------------------------------------------------

    /** @returns {ads.Client|null} The underlying ads-client instance */
    this.getClient = () => this.adsClient;

    /** @returns {boolean} */
    this.isConnected = () =>
      this.adsClient !== null && this.adsClient.connection.connected;

    /** @returns {boolean} */
    this.isConnecting = () => this.connecting !== null;

    /** @returns {ConnectionEventEmitter} */
    this.getEventEmitter = () => this.eventEmitter;

    /** Format an ads-client error for Node-RED debug panel */
    this.formatError = (err, msg) => {
      if (err.adsError) {
        if (typeof msg === "object" && msg !== null) {
          msg.adsError = err.adsError;
        }
        err.message = `${err.message} – ADS error ${err.adsError.errorCode} (${err.adsError.errorStr})`;
      }
      return err;
    };

    // ---- shared subscription management -----------------------------------

    /**
     * Called by subscribe nodes to request the shared ADS subscription.
     * The first caller triggers the actual ADS subscribeRaw; subsequent
     * callers just piggy-back on the existing subscription.
     */
    this.addSubscriber = async () => {
      this._subscriberCount++;

      if (this._subscription) {
        // Already subscribed — nothing to do
        return;
      }

      if (!this.adsClient || !this.isConnected()) {
        // Will be picked up when the "connected" event fires
        return;
      }

      await this._subscribe();
    };

    /**
     * Called by subscribe nodes when they close/stop.
     * When the last subscriber leaves, the ADS subscription is released.
     */
    this.removeSubscriber = async () => {
      this._subscriberCount = Math.max(0, this._subscriberCount - 1);

      if (this._subscriberCount === 0 && this._subscription) {
        await this._unsubscribe();
      }
    };

    /**
     * Internal: create the single ADS subscription.
     * Serialised so concurrent callers share one attempt.
     */
    this._subscribe = async () => {
      if (this._subscription) return;

      // If already in progress, wait for the existing attempt
      if (this._subscribing) {
        return this._subscribing;
      }

      this._subscribing = (async () => {
        try {
          this._subscription = await this.adsClient.subscribeRaw(
            constants.SUBSCRIBE_INDEX_GROUP,
            constants.SUBSCRIBE_INDEX_OFFSET,
            constants.SUBSCRIBE_BUFFER_SIZE,
            (data) => {
              // Forward raw notification data to all subscribe nodes
              this.eventEmitter.emit("eventData", data);
            },
            0,      // cycleTime (ms) – 0 = immediate
            false   // cyclic mode (NOT onChange)
          );
          this.log("Shared EventLogger subscription active");
        } catch (err) {
          this._subscription = null;
          this.warn(`Failed to create shared subscription: ${err.message}`);
          throw err;
        } finally {
          this._subscribing = null;
        }
      })();

      return this._subscribing;
    };

    /**
     * Internal: tear down the ADS subscription.
     */
    this._unsubscribe = async () => {
      if (!this._subscription) return;
      try {
        await this._subscription.unsubscribe();
        this.log("Shared EventLogger subscription removed");
      } catch (err) {
        this.warn(`Error removing subscription: ${err.message}`);
      }
      this._subscription = null;
    };

    // ---- lifecycle --------------------------------------------------------

    this.on("close", async (_removed, done) => {
      clearTimeout(this.retryTimer);

      this.log(
        `Disconnecting from EventLogger at ${this.connectionSettings.targetAmsNetId}:${this.connectionSettings.targetAdsPort}...`
      );

      if (this.adsClient === null) {
        done();
        return;
      }

      try {
        await this.adsClient.disconnect(
          !this.adsClient.connection.connected
        );
        this.log("Disconnected from EventLogger");
      } catch (err) {
        this.warn(`Disconnecting caused an error: ${err}`);
      } finally {
        this.adsClient = null;
        done();
      }
    });

    // Auto-connect when Node-RED starts
    this.connect().catch((err) => {
      this.warn(
        `Failed to connect to EventLogger at startup: ${err.message || err}`
      );
    });
  }

  RED.nodes.registerType(
    "ads-eventlogger-connection",
    AdsEventloggerConnection
  );
};
