import type { WebAccessSettings, WebAccessStatus } from "../../shared/web-access.js";
import type { DeviceBroker } from "./device-broker.mjs";
export interface WebBackend {
  call(method: string, args: unknown[]): Promise<unknown>;
  media(kind: string, filename: string, method: string, range?: string): Promise<Response>;
}
export interface WebAccessService {
  status(): WebAccessStatus;
  configure(input: WebAccessSettings): Promise<WebAccessStatus>;
  publish(channel: string, payload: unknown, deviceId?: string): void;
  close(): Promise<void>;
}
export function createWebAccess(options: {
  dataDir: string;
  rendererDir: string;
  bindAddress?: string;
  backend: WebBackend;
  helperFile?: string;
  onDeviceDisconnected?: (id: string, reason: string) => void;
  remoteBackend?: (id: string, broker: DeviceBroker, credential: { url: string; token: string }) => Promise<WebBackend>;
}): Promise<WebAccessService>;
