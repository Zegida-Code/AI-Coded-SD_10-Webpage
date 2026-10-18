// Web Bluetooth transport for the SD-10 (Microchip "Transparent UART" GATT profile).
import { UUID } from './protocol.js';

export class BleTransport {
  constructor({ chunkSize = 20, acceptAll = false } = {}) {
    this.chunkSize = chunkSize;
    this.acceptAll = acceptAll;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.device = null;
    this.tx = null;
    this.rx = null;
    this._onNotify = (e) => {
      const v = e.target.value;
      this.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    };
    this._onGattDisconnected = () => this.onDisconnect();
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get name() { return this.device?.name || 'SD-10'; }

  async connect() {
    if (!BleTransport.supported) throw new Error('Web Bluetooth is not available. Use Chrome or Edge (desktop/Android) over HTTPS or localhost.');
    const options = this.acceptAll
      ? { acceptAllDevices: true, optionalServices: [UUID.SERVICE, UUID.ADVERTISED_SERVICE] }
      : { filters: [{ services: [UUID.ADVERTISED_SERVICE] }], optionalServices: [UUID.SERVICE] };
    this.device = await navigator.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(UUID.SERVICE);
    this.tx = await service.getCharacteristic(UUID.TX);
    this.rx = await service.getCharacteristic(UUID.RX);
    this.rx.addEventListener('characteristicvaluechanged', this._onNotify);
    await this.rx.startNotifications();
  }

  async write(bytes) {
    for (let i = 0; i < bytes.length; i += this.chunkSize) {
      const chunk = bytes.subarray(i, i + this.chunkSize);
      if (this.tx.writeValueWithResponse) await this.tx.writeValueWithResponse(chunk);
      else await this.tx.writeValue(chunk);
    }
  }

  async disconnect() {
    try { await this.rx?.stopNotifications(); } catch { /* already gone */ }
    this.rx?.removeEventListener('characteristicvaluechanged', this._onNotify);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
}
